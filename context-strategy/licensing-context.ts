import {
    PlatformAdapter,
    LicenseStockRecord,
    LicenseUsageRecord,
    LicenseFile
} from '../platform-adapter';
import { CloudFunctionProxyAdapter } from '../cloud-function-proxy';
import { VirtualMachine } from '../virtual-machine';
import path from 'path';
import { HealthCheckSyncState } from '../master-election';

export enum LicensingStrategyResult {
    LicenseAssigned = 'license-assigned',
    LicenseOutOfStock = 'license-out-of-stock',
    LicenseNotRequired = 'license-not-required'
}

/**
 * To provide Licensing model related logics such as license assignment.
 */
export interface LicensingModelContext {
    setLicensingStrategy(strategy: LicensingStrategy): void;
    handleLicenseAssignment(productName: string): Promise<string>;
}

export interface LicensingStrategy {
    prepare(
        platform: PlatformAdapter,
        proxy: CloudFunctionProxyAdapter,
        vm: VirtualMachine,
        productName: string,
        storageContainerName: string,
        licenseDirectoryName: string
    ): Promise<void>;
    apply(): Promise<LicensingStrategyResult>;
    getLicenseContent(): Promise<string>;
}

export class NoopLicensingStrategy implements LicensingStrategy {
    platform: PlatformAdapter;
    proxy: CloudFunctionProxyAdapter;
    vm: VirtualMachine;
    storageContainerName: string;
    licenseDirectoryName: string;
    prepare(
        platform: PlatformAdapter,
        proxy: CloudFunctionProxyAdapter,
        vm: VirtualMachine,
        storageContainerName: string,
        licenseDirectoryName: string
    ): Promise<void> {
        this.platform = platform;
        this.proxy = proxy;
        this.vm = vm;
        this.storageContainerName = storageContainerName;
        this.licenseDirectoryName = licenseDirectoryName;
        return Promise.resolve();
    }
    apply(): Promise<LicensingStrategyResult> {
        this.proxy.logAsInfo('calling NoopLicensingStrategy.apply');
        this.proxy.logAsInfo('noop');
        this.proxy.logAsInfo('called NoopLicensingStrategy.apply');
        return Promise.resolve(LicensingStrategyResult.LicenseNotRequired);
    }
    getLicenseContent(): Promise<string> {
        return Promise.resolve('');
    }
}

export class ReusableLicensingStrategy implements LicensingStrategy {
    platform: PlatformAdapter;
    proxy: CloudFunctionProxyAdapter;
    vm: VirtualMachine;
    storageContainerName: string;
    licenseDirectoryName: string;
    licenseFiles: LicenseFile[];
    stockRecords: LicenseStockRecord[];
    usageRecords: LicenseUsageRecord[];
    licenseRecord: LicenseStockRecord | null;
    private licenseFile: LicenseFile;
    productName: string;
    prepare(
        platform: PlatformAdapter,
        proxy: CloudFunctionProxyAdapter,
        vm: VirtualMachine,
        productName: string,
        storageContainerName: string,
        licenseDirectoryName: string
    ): Promise<void> {
        this.platform = platform;
        this.proxy = proxy;
        this.vm = vm;
        this.productName = productName;
        this.storageContainerName = storageContainerName;
        this.licenseDirectoryName = licenseDirectoryName;
        this.licenseFiles = [];
        this.stockRecords = [];
        this.usageRecords = [];
        return Promise.resolve();
    }
    async apply(): Promise<LicensingStrategyResult> {
        this.proxy.logAsInfo('calling ReusableLicensingStrategy.apply');
        [this.licenseFiles, this.stockRecords, this.usageRecords] = await Promise.all([
            this.platform
                .listLicenseFiles(this.storageContainerName, this.licenseDirectoryName)
                .catch(err => {
                    this.proxy.logForError('failed to list license blob files.', err);
                    return null;
                }),
            this.platform.listLicenseStock(this.productName).catch(err => {
                this.proxy.logForError('failed to list license stock', err);
                return null;
            }),
            this.platform.listLicenseUsage(this.productName).catch(err => {
                this.proxy.logForError('failed to list license stock', err);
                return null;
            })
        ]);
        // update the license stock records on db if any change in file storage
        // this returns the newest stockRecords on the db
        await this.updateLicenseStockRecord(this.licenseFiles);
        this.stockRecords = await this.platform.listLicenseStock(this.productName);

        // is the license in use by the same vm?
        [this.licenseRecord] = Array.from(this.usageRecords.values()).filter(record => {
            return record.vmId === this.vm.id;
        }) || [null];

        if (!this.licenseRecord) {
            // get an available license
            try {
                this.licenseRecord = await this.getAvailableLicense();
                // load license content
                const filePath = path.join(this.licenseDirectoryName, this.licenseRecord.fileName);
                const content = await this.platform.loadLicenseFileContent(
                    this.storageContainerName,
                    filePath
                );
                this.licenseFile = {
                    fileName: this.licenseRecord.fileName,
                    checksum: this.licenseRecord.checksum,
                    algorithm: this.licenseRecord.algorithm,
                    content: content
                };
                this.proxy.logAsInfo(
                    `license file (name: ${this.licenseFile.fileName},` +
                        ` checksum: ${this.licenseFile.checksum}) is loaded.`
                );
            } catch (error) {
                this.proxy.logForError('Failed to get a license.', error);
                throw new error();
            }
        }

        this.proxy.logAsInfo('called ReusableLicensingStrategy.apply');
        return LicensingStrategyResult.LicenseAssigned;
    }
    async updateLicenseStockRecord(licenseFiles: LicenseFile[]): Promise<void> {
        const stockArray = licenseFiles.map(f => {
            return {
                fileName: f.fileName,
                checksum: f.checksum,
                algorithm: f.algorithm
            } as LicenseStockRecord;
        });
        await this.platform.updateLicenseStock(stockArray);
    }

    /**
     * sync the vm in-sync status from the scaling group to the usage record
     *
     * @protected
     * @param {LicenseUsageRecord[]} usageRecords array of license usage record
     * @returns {Promise<void>} void
     */
    protected async syncVmStatusToUsageRecords(usageRecords: LicenseUsageRecord[]): Promise<void> {
        const updatedRecordArray = await Promise.all(
            usageRecords.map(async u => {
                const healthCheckRecord = await this.platform.getHealthCheckRecord(u.vmId);
                u.vmInSync = healthCheckRecord.syncState === HealthCheckSyncState.InSync;
                return u;
            })
        );
        await this.platform.updateLicenseUsage(updatedRecordArray);
    }

    protected async listOutOfSyncRecord(
        usageRecords: LicenseUsageRecord[],
        sync?: boolean
    ): Promise<LicenseUsageRecord[]> {
        if (sync) {
            await this.syncVmStatusToUsageRecords(usageRecords);
            usageRecords = Array.from(
                (await this.platform.listLicenseUsage(this.productName)).values()
            );
        }
        return Array.from(usageRecords.values()).filter(usageRecrod => {
            return !usageRecrod.vmInSync;
        });
    }
    protected async getAvailableLicense(): Promise<LicenseStockRecord> {
        let outOfSyncArray: LicenseUsageRecord[];
        // try to look for an unused one first
        // checksum is the unique key of a license
        const usageMap: Map<string, LicenseStockRecord> = new Map(
            this.usageRecords.map(u => [u.checksum, u])
        );
        const unusedArray = this.stockRecords.filter(
            stockRecord => !usageMap.has(stockRecord.checksum)
        );
        // if no availalbe, check if any in-use license is associated with a vm which isn't in-sync
        if (unusedArray.length === 0) {
            outOfSyncArray = await this.listOutOfSyncRecord(this.usageRecords);
            // if every license is in use and seems to be in-sync,
            // sync the record with vm running state and heartbeat records,
            // then check it once again
            if (outOfSyncArray.length === 0) {
                outOfSyncArray = await this.listOutOfSyncRecord(this.usageRecords, true);
            }
            // run out of license
            if (outOfSyncArray.length === 0) {
                throw new Error('Run out of license.');
            } else {
                // pick the fist one and return as a reusable license
                this.proxy.logAsInfo(
                    `A reusable license (checksum: ${outOfSyncArray[0].checksum},` +
                        ` previous assigned vmId: ${outOfSyncArray[0].vmId},` +
                        ` file name: ${outOfSyncArray[0].fileName}) is found.`
                );
                return outOfSyncArray[0];
            }
        } else {
            // pick the first one and return as unused license
            this.proxy.logAsInfo(
                `An unused license (checksum: ${unusedArray[0].checksum}, ` +
                    `file name: ${unusedArray[0].fileName}) is found.`
            );
            return unusedArray[0];
        }
    }
    getLicenseContent(): Promise<string> {
        return Promise.resolve(this.licenseFile.content);
    }
}