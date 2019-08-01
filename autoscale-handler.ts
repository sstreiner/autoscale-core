/*
Author: Fortinet
*
* AutoscaleHandler contains the core used to handle serving configuration files and
* manage the autoscale events from multiple cloud platforms.
*
* Use this class in various serverless cloud contexts. For each serverless cloud
* implementation extend this class and implement the handle() method. The handle() method
* should call other methods as needed based on the input events from that cloud's
* autoscale mechanism and api gateway requests from the FortiGate's callback-urls.
* (see reference AWS implementation {@link AwsAutoscaleHandler})
*
* Each cloud implementation should also implement a concrete version of the abstract
* {@link CloudPlatform} class which should be passed to super() in the constructor. The
* CloudPlatform interface should abstract each specific cloud's api. The reference
* implementation {@link AwsPlatform} handles access to the dynamodb for persistence and
* locking, interacting with the aws autoscaling api and determining the api endpoint url
* needed for the FortiGate config's callback-url parameter.
*/

import * as path from 'path'
import * as CoreFunctions from './core-functions'
import { VirtualMachine, NetworkInterfaceLike } from './virtual-machine'
import { HealthCheck } from './health-check-record'
import * as MasterElection from './master-election'
import {
    CloudPlatform,
    RequestInfo,
    VirtualMachineDescriptor,
    SettingItems,
    SubnetPair,
    RuntimeAgent,
    ErrorDataPairLike,
    BlobStorageItemDescriptor,
    ValidHeartbeatInterval,
    HttpStatusCode,
    MaskedResponse,
    USE_EXISTING
} from './cloud-platform'
import { LicenseItem } from './license-item'
import { LicenseRecord } from './license-record'
import { LifecycleAction } from './lifecycle-item'
import { URL } from 'url'
import { Logger } from './logger'


const AUTOSCALE_SECTION_EXPR = /(?:^|(?:\s*))config?\s*system?\s*auto-scale\s*((?:.|\s)*)\bend\b/
const NO_HEART_BEAT_INTERVAL_SPECIFIED = -1
const DEFAULT_HEART_BEAT_INTERVAL = 30

export enum ScalingGroupState {
    inService = 'in-service',
    inTransition = 'in-transition',
    stopped = 'stopped',
}

export enum RetrieveMasterOption {
    masterInfo = 'masterInfo',
    masterHealthCheck = 'masterHealthCheck',
    masterRecord = 'masterRecord',
}

export interface ConfigSetParser {
    configsetName: string
    location: string
    dataSource: any
}

export abstract class AutoscaleHandler<
    HttpRequest,
    RuntimeContext,
    PlatformLogger,
    KeyValueLike,
    VmSourceType,
    VM extends VirtualMachine<VmSourceType, NetworkInterfaceLike>,
    RA extends RuntimeAgent<HttpRequest, RuntimeContext, PlatformLogger>,
    CP extends CloudPlatform<
        HttpRequest, RuntimeContext, PlatformLogger,
        KeyValueLike, VmSourceType, VM, RA
    >
> {
    protected _selfInstance: VM | null
    protected _selfHealthCheck: HealthCheck | null
    protected _masterHealthCheck: HealthCheck | null
    protected _masterRecord: MasterElection.MasterRecord | null
    protected _masterInfo: VM | null
    protected _requestInfo: RequestInfo | null
    protected _baseConfig: string
    protected scalingGroupName: string
    protected logger: Logger<PlatformLogger>
    constructor(readonly platform: CP) {
        this._selfInstance = null
        this._selfHealthCheck = null
        this._masterRecord = null
        this._masterInfo = null
        this._requestInfo = null
        this.scalingGroupName = ''
        this._baseConfig = ''
    }

    // TODO: do we still need this?
    static get NO_HEART_BEAT_INTERVAL_SPECIFIED() {
        return NO_HEART_BEAT_INTERVAL_SPECIFIED
    }

    // TODO: do we still need this?
    static get DEFAULT_HEART_BEAT_INTERVAL() {
        return DEFAULT_HEART_BEAT_INTERVAL
    }

    protected get masterScalingGroupName(): string {
        return this.platform.masterScalingGroupName
    }

    /**
     * Get the read-only settings object from the platform. To modify the settings object,
     * do it via the platform instance but not here.
     */
    // TODO: improve this
    get _settings(): SettingItems {
        return this.platform._settings
    }

    async init() {
        this.logger.info('calling init [Autoscale handler initialization]')
        // do the cloud platform initialization
        const success = this.platform.initialized || (await this.platform.init())
        // ensure that the settings are saved properly.
        // check settings availability

        // if there's limitation for a platform that it cannot save settings to db during
        // deployment. the deployment template must create a service function that takes all
        // deployment settings as its environment variables. The CloudPlatform class must
        // invoke this service function to store all settings to db. and also create a flag
        // setting item 'deployment-settings-saved' with value set to 'true'.
        // from then on, it can load item from db.
        // if this process cannot be done during the deployment, it must be done once here in the
        // init function of the platform-specific autoscale-handler.
        // by doing so, catch the error 'Deployment settings not saved.' and handle it.
        this.logger.info('checking deployment setting items')
        await this.loadSettings()
        if (!this._settings || (this._settings && !this._settings['deployment-settings-saved'])) {
            // in the init function of each platform autoscale-handler, this error must be caught
            // and provide addtional handling code to save the settings
            throw new Error('Deployment settings not saved.')
        }

        // set scaling group names for master and self
        this.setScalingGroup(
            // TODO:
            //the data structure here for this._settings is not good.Needs to improve it
            //Because it can hold a value of string or json object type,
            //However, this will fail if the property is undefined/null.
            // .toString() actually stringifies the object type value. any better way?
            this._settings['master-scaling-group-name'].toString(),
            this._settings['master-scaling-group-name'].toString()
        )
        return success
    }

    // TODO: interim idea for handling. develop it later.
    abstract async handleWithAgent(): Promise<any>

    /* eslint-disable max-len */
    /**
     *
     * @param {Platform.RequestEvent} event Event from platform.
     * @param {Platform.RequestContext} context the runtime context of this function
     * call from the platform
     * @param {Platform.RequestCallback} callback the callback function the platorm
     * uses to end a request
     * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
     */
    // TODO: improve the handle and formal parameters
    // NOTE:
    // see detailed code review comments on: 75699/1/core/autoscale-handler.ts#149
    async handle(event: any, context: any, callback: any) {
        // eslint-disable-line no-unused-vars
        let step = 'initializing'
        let proxyMethod =
                ('method' in event && event.method) || ('httpMethod' in event && event.httpMethod),
            result
        try {
            const platformInitSuccess = await this.init()
            // return 500 error if script cannot finish the initialization.
            if (!platformInitSuccess) {
                result = 'fatal error, cannot initialize.'
                this.logger.error(result)
                callback(null, this.proxyResponse(500, result))
            } else if (event.source === 'autoscaling') {
                step = 'autoscaling'
                result = await this.handleAutoScalingEvent(event)
                callback(null, this.proxyResponse(200, result))
            } else {
                // authenticate the calling instance
                this.parseRequestInfo(event)
                if (!this._requestInfo.instanceId) {
                    callback(null, this.proxyResponse(403, 'Instance id not provided.'))
                    return
                }
                await this.parseInstanceInfo(this._requestInfo.instanceId)

                await this.checkInstanceAuthorization(this._selfInstance)

                if (proxyMethod === 'GET') {
                    step = 'fortigate:getConfig'
                    result = await this.handleGetConfig()
                    callback(null, this.proxyResponse(200, result))
                } else if (proxyMethod === 'POST') {
                    step = 'fortigate:handleSyncedCallback'
                    // handle status messages
                    if (this._requestInfo.status) {
                        result = await this.handleStatusMessage(event)
                    } else {
                        result = await this.handleSyncedCallback()
                    }
                    callback(null, this.proxyResponse(200, result))
                } else {
                    step = '¯\\_(ツ)_/¯'

                    this.logger.warn(`${step} unexpected event!`, event)
                    // probably a test call?
                    callback(null, this.proxyResponse(500, result))
                }
            }
        } catch (ex) {
            if (ex.message) {
                ex.message = `${step}: ${ex.message}`
            }
            try {
                console.error('ERROR while ', step, proxyMethod, ex)
            } catch (ex2) {
                console.error('ERROR while ', step, proxyMethod, ex.message, ex, ex2)
            }
            if (proxyMethod) {
                callback(
                    null,
                    this.proxyResponse(500, {
                        message: ex.message,
                        stack: ex.stack,
                    })
                )
            } else {
                callback(ex)
            }
        }
    }

    // TODO: this function need to be replace. will use the runtimeAgent & ErrorDataPairLike instead
    abstract proxyResponse(statusCode: number, res: {}, logOptions?: {}): any

    async getConfigSet(configName: string): Promise<string> {
        try {
            let keyPrefix = this._settings['asset-storage-key-prefix']
                ? path.join(this._settings['asset-storage-key-prefix'].toString(), 'configset')
                : 'configset'
            const parameters: BlobStorageItemDescriptor = {
                storageName: this._settings['asset-storage-name'].toString(),
                keyPrefix: keyPrefix,
                fileName: configName,
            }
            let blob = await this.platform.getBlobFromStorage(parameters)
            // replace Windows line feed \r\n with \n to normalize the config set
            if (
                blob.content &&
                typeof blob.content === 'string' &&
                blob.content.indexOf('\r') >= 0
            ) {
                // eslint-disable-next-line no-control-regex
                return blob.content.replace(new RegExp('\r', 'g'), '')
            } else {
                return blob.content
            }
        } catch (error) {
            this.logger.warn(`called getConfigSet > error: ${error}`)
            throw error
        }
    }

    async getBaseConfig(): Promise<string> {
        let baseConfig = await this.getConfigSet('baseconfig')
        let psksecret = this._settings['fortigate-psk-secret'].toString(),
            fazConfig = '',
            fazIp
        if (baseConfig) {
            // check if other config set are required
            let requiredConfigSet: string = this._settings['required-configset'].toString() || ''
            let configContent = ''
            // check if second nic is enabled, config for the second nic must be prepended to
            // base config
            if (this._settings['enable-second-nic'].toString() === 'true') {
                baseConfig = (await this.getConfigSet('port2config')) + baseConfig
            }
            for (let configset of requiredConfigSet.split(',')) {
                let [name, selected] = configset.trim().split('-')
                if (selected && selected.toLowerCase() === 'yes') {
                    switch (name) {
                        // handle https routing policy
                        case 'httpsroutingpolicy':
                            configContent += await this.getConfigSet('internalelbweb')
                            configContent += await this.getConfigSet(name)
                            break
                        // handle fortianalyzer logging config
                        case 'storelogtofaz':
                            fazConfig = await this.getConfigSet(name)
                            fazIp = await this.getFazIp()
                            configContent += fazConfig.replace(
                                new RegExp('{FAZ_PRIVATE_IP}', 'gm'),
                                fazIp
                            )
                            break
                        case 'extrastaticroutes':
                            configContent += await this.getConfigSet('extrastaticroutes')
                            break
                        case 'extraports':
                            configContent += await this.getConfigSet('extraports')
                            break
                        default:
                            break
                    }
                }
            }
            baseConfig += configContent

            baseConfig = baseConfig
                .replace(
                    new RegExp('{SYNC_INTERFACE}', 'gm'),
                    (this._settings['fortigate-sync-interface'] &&
                        this._settings['fortigate-sync-interface'].toString()) ||
                        'port1'
                )
                .replace(new RegExp('{EXTERNAL_INTERFACE}', 'gm'), 'port1')
                .replace(new RegExp('{INTERNAL_INTERFACE}', 'gm'), 'port2')
                .replace(new RegExp('{PSK_SECRET}', 'gm'), psksecret)
                .replace(
                    new RegExp('{TRAFFIC_PORT}', 'gm'),
                    (this._settings['fortigate-traffic-port'] &&
                        this._settings['fortigate-traffic-port'].toString()) ||
                        '443'
                )
                .replace(
                    new RegExp('{ADMIN_PORT}', 'gm'),
                    (this._settings['fortigate-admin-port'] &&
                        this._settings['fortigate-admin-port'].toString()) ||
                        '8443'
                )
                .replace(
                    new RegExp('{HEART_BEAT_INTERVAL}', 'gm'),
                    (this._settings['heartbeat-interval'] &&
                        this._settings['heartbeat-interval'].toString()) ||
                        '30'
                )
                .replace(
                    new RegExp('{INTERNAL_ELB_DNS}', 'gm'),
                    (this._settings['fortigate-protected-internal-elb-dns'] &&
                        this._settings['fortigate-protected-internal-elb-dns'].toString()) ||
                        ''
                )
        }
        return baseConfig
    }

    parseRequestInfo(runtimeAgent: RA) {
        this._requestInfo = this.platform.extractRequestInfo(runtimeAgent)
    }

    async parseInstanceInfo(instanceId: string): Promise<void> {
        // look for this vm in both byol and payg vmss
        // look from byol first
        this._selfInstance =
            this._selfInstance ||
            (await this.platform.describeInstance(<VirtualMachineDescriptor>{
                instanceId: instanceId,
                scalingGroupName:
                    this._settings['byol-scaling-group-name'] &&
                    this._settings['byol-scaling-group-name'].toString(),
            }))
        if (this._selfInstance) {
            this.setScalingGroup(
                this._settings['master-scaling-group-name'] &&
                    this._settings['master-scaling-group-name'].toString(),
                this._settings['byol-scaling-group-name'] &&
                    this._settings['byol-scaling-group-name'].toString()
            )
        } else {
            // not found in byol vmss, look from payg
            this._selfInstance = await this.platform.describeInstance(<VirtualMachineDescriptor>{
                instanceId: instanceId,
                scalingGroupName:
                    this._settings['payg-scaling-group-name'] &&
                    this._settings['payg-scaling-group-name'].toString(),
            })

            if (this._selfInstance) {
                this.setScalingGroup(
                    this._settings['master-scaling-group-name'] &&
                        this._settings['master-scaling-group-name'].toString(),
                    this._settings['payg-scaling-group-name'] &&
                        this._settings['payg-scaling-group-name'].toString()
                )
            }
        }
        if (this._selfInstance) {
            this.logger.info(
                `instance identification (id: ${this._selfInstance.instanceId}, ` +
                    `scaling group self: ${this.scalingGroupName}, ` +
                    `master: ${this.masterScalingGroupName})`
            )
        } else {
            this.logger.warn(`cannot identify instance: vmid:(${instanceId})`)
        }
    }

    // TODO: Is this specific to a certain platform? If you are concerned about the calling
    // instance, why not lock down the function via a security group ? Why do this part in the code?
    async checkInstanceAuthorization(instance: VM): Promise<boolean> {
        // TODO: can we generalize this method to core?
        if (
            !instance ||
            instance.virtualNetworkId !== this._settings['fortigate-autoscale-vpc-id'].toString()
        ) {
            // not trusted
            return await Promise.reject(
                'Unauthorized calling instance (' +
                    `instanceId: ${(instance && instance.instanceId) ||
                        null}). Instance not found in VPC.`
            )
        }
        return await Promise.resolve(true)
    }

    //TODO: improve this function
    async handleGetLicense(runtimeAgent?: RA) {
        let result;
        let ra: RA = runtimeAgent || this.platform.runtimeAgent;
        this.logger.info('calling handleGetLicense')
        try {
            const platformInitSuccess = await this.init()
            // return 500 error if script cannot finish the initialization.
            if (!platformInitSuccess) {
                result = 'fatal error, cannot initialize.'
                this.logger.error(result)
                this.platform.respond(<ErrorDataPairLike>{
                    error: new Error(result),
                    data: null
                }, HttpStatusCode.INTERNAL_SERVER_ERROR);
                return
            }

            // authenticate the calling instance
            this.parseRequestInfo(ra);
            if (!this._requestInfo.instanceId) {
                this.platform.respond({
                    error: null,
                    data: 'Instance id not provided.'
                }, HttpStatusCode.FORBIDDEN);
                return
            }
            await this.parseInstanceInfo(this._requestInfo.instanceId)

            await this.checkInstanceAuthorization(this._selfInstance)

            let [licenseFiles, stockRecords, usageRecords] = await Promise.all([
                this.platform.listLicenseFiles(), // expect it to return a map
                this.platform.listLicenseStock(), // expect it to return a map
                this.platform.listLicenseUsage(), // expect it to return a map
            ])

            // update the license stock records on db if any change in file storage
            // this returns the newest stockRecords on the db
            stockRecords = await this.updateLicenseStockRecord(licenseFiles, stockRecords)

            // start to pick a valid license here.
            let availStockItem: LicenseItem, availStockRecord: LicenseRecord

            let itemKey, itemValue

            let promiseEmitter = async () => {
                let updateUsage = true,
                    replaceUsageRecord = false
                // TODO: remove the workaround if mantis item: #0534971 is resolved
                // a workaround for double get call:
                // check if a license is already assigned to one fgt, if it makes a second get call
                // for license, returns the tracked usage record.

                for ([itemKey, itemValue] of usageRecords.entries()) {
                    if (
                        itemValue.scalingGroupName === this.scalingGroupName &&
                        itemValue.instanceId === this._selfInstance.instanceId
                    ) {
                        availStockRecord = itemValue
                        availStockItem = licenseFiles.get(itemValue.blobKey)
                        updateUsage = false
                        break
                    }
                }

                // this is a greedy approach
                // try to find one available license and use it.
                // if none availabe, try to check if any used one could be recycled.
                // if none recyclable, throw an error.

                // NOTE: need to handle concurrent license requests.
                // if two device request license at the same time, race condition will occur.
                // insert licenseUsage record (neither replace nor update), if insert fail,
                // start it over in 2 seconds.

                if (!availStockItem) {
                    for ([itemKey, itemValue] of stockRecords.entries()) {
                        if (itemKey && !usageRecords.has(itemKey)) {
                            availStockRecord = itemValue
                            availStockItem = licenseFiles.get(itemValue.blobKey)
                            break
                        }
                    }

                    // if not found available license file
                    if (!availStockItem) {
                        ;[availStockRecord] = await this.findRecyclableLicense(
                            stockRecords,
                            usageRecords,
                            1
                        )
                        availStockItem =
                            availStockRecord &&
                            licenseFiles &&
                            licenseFiles.get(availStockRecord.blobKey)
                        replaceUsageRecord = !!availStockItem
                    }
                }

                // if the selected licenseItem does not contain a content, fetch it from storage
                // this will also update the checksum and algorithm which will be saved in the
                // usage record too.
                if (!availStockItem.content) {
                    availStockItem.content = await this.platform.getLicenseFileContent(<
                        BlobStorageItemDescriptor
                    >{
                        storageName: this._settings['asset-storage-name'].toString(),
                        keyPrefix: path.join(
                            this._settings['asset-storage-key-prefix'].toString(),
                            this._settings['fortigate-license-storage-key-prefix'].toString()
                        ),
                        fileName: availStockItem.fileName,
                    })
                }

                // license file found
                // update usage records
                let usageUpdated = false
                if (availStockItem && updateUsage) {
                    availStockRecord.updateUsage(
                        this._selfInstance.instanceId,
                        this._selfInstance.scalingGroupName
                    )
                    // if usage record not updated, try to use another one
                    usageUpdated = await this.platform.updateLicenseUsage(
                        availStockRecord,
                        replaceUsageRecord
                    )
                    // reset availStockItem if cannot update
                    if (!usageUpdated) {
                        availStockItem = null
                        // fetch the latest usage record from db again.
                        usageRecords = await this.platform.listLicenseUsage()
                    }
                }
                return availStockItem
            }

            let validator = (stockItem: LicenseItem) => {
                return !!stockItem
            }

            await CoreFunctions.waitFor(promiseEmitter, validator, 5000, 3)

            if (!availStockItem) {
                throw new Error('No license available.')
            }

            this.logger.info(
                `called handleGetLicense, license: ${availStockItem.fileName} is ` +
                    `assigned to instance (id: ${this._selfInstance.instanceId}).`
            )

            this.platform.respond(<MaskedResponse>{
                error: null,
                data: availStockItem.content,
                maskResponse: true
            }, HttpStatusCode.OK);
        } catch (ex) {
            this.platform.respond(<ErrorDataPairLike>{
                error: ex,
                data: 'Error in getting license. Please check logs.'
            }, HttpStatusCode.INTERNAL_SERVER_ERROR);
        }
    }

    /**
     * Handle the 'auto-scale synced' callback from the FortiGate.
     * the first callback will be considered as an indication for instance "up-and-running"
     * @param {*} event event from the handling call. structure varies per platform.
     */
    async handleSyncedCallback(): Promise<{} | string> {
        const instanceId = this._requestInfo.instanceId,
            interval = this._requestInfo.interval === USE_EXISTING ?
                DEFAULT_HEART_BEAT_INTERVAL : Number(this._requestInfo.interval)

        let masterIp,
            isMaster = false,
            lifecycleShouldAbandon = false

        // get selfinstance
        this._selfInstance =
            this._selfInstance ||
            (await this.platform.describeInstance(<VirtualMachineDescriptor>{
                instanceId: instanceId,
                scalingGroupName: this.scalingGroupName,
            }))

        // handle hb monitor
        // get self health check
        this._selfHealthCheck =
            this._selfHealthCheck ||
            (await this.platform.getInstanceHealthCheck(
                <VirtualMachineDescriptor>{
                    instanceId: this._selfInstance.instanceId,
                },
                interval
            ))
        // if self is already out-of-sync, skip the monitoring logics
        if (this._selfHealthCheck && !this._selfHealthCheck.inSync) {
            return {}
        }
        // get master instance monitoring
        await this.retrieveMaster()

        // if this instance is the master, skip checking master election
        if (
            this._masterInfo &&
            this._selfInstance.instanceId === this._masterInfo.instanceId &&
            this.scalingGroupName === this.masterScalingGroupName
        ) {
            // use master health check result as self health check result
            isMaster = true
            this._selfHealthCheck = this._masterHealthCheck
        } else if (this._selfHealthCheck && !this._selfHealthCheck.healthy) {
            // if this instance is unhealth, skip master election check
        } else if (
            !(this._masterInfo && this._masterHealthCheck && this._masterHealthCheck.healthy)
        ) {
            // if no master or master is unhealthy, try to run a master election or check if a
            // master election is running then wait for it to end
            // promiseEmitter to handle the master election process by periodically check:
            // 1. if there is a running election, then waits for its final
            // 2. if there isn't a running election, then runs an election and complete it
            let promiseEmitter = this.checkMasterElection.bind(this),
                // validator set a condition to determine if the fgt needs to keep waiting or not.
                validator = (masterInfo: VM) => {
                    // if i am the new master, don't wait, continue to finalize the election.
                    // should return yes to end the waiting.
                    if (
                        masterInfo &&
                        masterInfo.primaryPrivateIpAddress ===
                            this._selfInstance.primaryPrivateIpAddress
                    ) {
                        isMaster = true
                        return true
                    } else if (
                        this._masterRecord &&
                        this._masterRecord.voteState === MasterElection.VoteState.pending
                    ) {
                        // if no wait for master election, I could become a headless instance
                        // may allow any non master instance to come up without master.
                        // They will receive the new master ip on one of their following
                        // heartbeat sync callback
                        if (this._settings['master-election-no-wait'].toString() === 'true') {
                            return true
                        } else {
                            // if i am not the new master, and the new master hasn't come up to
                            // finalize the election, I should keep on waiting.
                            // should return false to continue.
                            this._masterRecord = null // clear the master record cache
                            return false
                        }
                    } else if (
                        this._masterRecord &&
                        this._masterRecord.voteState === MasterElection.VoteState.done
                    ) {
                        // if i am not the new master, and the master election is final, then no
                        // need to wait.
                        // should return true to end the waiting.
                        return true
                    } else {
                        // no master elected yet
                        // entering this syncedCallback function means i am already insync so
                        // i used to be assigned a master.
                        // if i am not in the master scaling group then I can't start a new
                        // election.
                        // i stay as is and hoping for someone in the master scaling group
                        // triggers a master election. Then I will be notified at some point.
                        if (this.scalingGroupName !== this.masterScalingGroupName) {
                            return true
                        } else {
                            // for new instance or instance in the master scaling group
                            // they should keep on waiting
                            return false
                        }
                    }
                },
                // counter to set a time based condition to end this waiting. If script execution
                // time is close to its timeout (6 seconds - abount 1 inteval + 1 second), ends the
                // waiting to allow for the rest of logic to run
                counter = (currentCount: number) => {
                    // eslint-disable-line no-unused-vars
                    if (Date.now() < this.platform.getExecutionTimeRemaining() - 6000) {
                        return false
                    }
                    this.logger.warn('script execution is about to expire')
                    return true
                }

            try {
                this._masterInfo = await CoreFunctions.waitFor(
                    promiseEmitter,
                    validator,
                    5000,
                    counter
                )
                // after new master is elected, get the new master healthcheck
                // there are two possible results here:
                // 1. a new instance comes up and becomes the new master, master healthcheck won't
                // exist yet because this instance isn't added to monitor.
                //   1.1. in this case, the instance will be added to monitor.
                // 2. an existing slave instance becomes the new master, master healthcheck exists
                // because the instance in under monitoring.
                //   2.1. in this case, the instance will take actions based on its healthcheck
                //        result.
                this._masterHealthCheck = null // invalidate the master health check object
                // reload the master health check object
                await this.retrieveMaster()
            } catch (error) {
                // if error occurs, check who is holding a master election, if it is this instance,
                // terminates this election. then continue
                await this.retrieveMaster(null, true)

                if (
                    this._masterRecord.instanceId === this._selfInstance.instanceId &&
                    this._masterRecord.scalingGroupName === this._selfInstance.scalingGroupName
                ) {
                    await this.platform.removeMasterRecord()
                }
                await this.removeInstance(this._selfInstance)
                throw new Error(
                    'Failed to determine the master instance within ' +
                        `${this.platform.getExecutionTimeRemaining() / 1000} seconds. ` +
                        'This instance is unable to bootstrap. Please report this to administrators.'
                )
            }
        }

        // check if myself is under health check monitoring
        // (master instance itself may have got its healthcheck result in some code blocks above)
        this._selfHealthCheck =
            this._selfHealthCheck ||
            (await this.platform.getInstanceHealthCheck(
                <VirtualMachineDescriptor>{
                    instanceId: this._selfInstance.instanceId,
                },
                interval
            ))

        // if this instance is the master instance and the master record is still pending, it will
        // finalize the master election.
        if (
            this._masterInfo &&
            this._selfInstance.instanceId === this._masterInfo.instanceId &&
            this.scalingGroupName === this.masterScalingGroupName &&
            this._masterRecord &&
            this._masterRecord.voteState === MasterElection.VoteState.pending
        ) {
            isMaster = true
            if (
                !this._selfHealthCheck ||
                (this._selfHealthCheck && this._selfHealthCheck.healthy)
            ) {
                // if election couldn't be finalized, remove the current election so someone else
                // could start another election
                if (!(await this.platform.finalizeMasterElection())) {
                    await this.platform.removeMasterRecord()
                    this._masterRecord = null
                    lifecycleShouldAbandon = true
                }
            }
        }

        // if no self healthcheck record found, this instance not under monitor. It's about the
        // time to add it to monitor. should make sure its all lifecycle actions are complete
        // while starting to monitor it.
        // if this instance is not the master, still add it to monitor but leave its master unknown.
        // if there's a master instance, add the monitor record using this master regardless
        // the master health status.
        if (!this._selfHealthCheck) {
            // check if a lifecycle event waiting
            // handle the lifecycle action
            //NOTE: for those platforms don't offer lifecycle handling, the handleLifecycleAction()
            // could be implemented as always returning true.
            await this.handleLifecycleAction(
                this._selfInstance.instanceId,
                LifecycleAction.ACTION_NAME_GET_CONFIG,
                !lifecycleShouldAbandon
            )

            masterIp = this._masterInfo ? this._masterInfo.primaryPrivateIpAddress : null
            // if slave finds master is pending, don't update master ip to the health check record
            if (
                !isMaster &&
                this._masterRecord &&
                this._masterRecord.voteState === MasterElection.VoteState.pending &&
                this._settings['master-election-no-wait'].toString() === 'true'
            ) {
                masterIp = null
            }
            await this.addInstanceToMonitor(this._selfInstance, interval, masterIp)
            let logMessagMasterIp =
                !masterIp && this._settings['master-election-no-wait'].toString() === 'true'
                    ? ' without master ip)'
                    : ` master-ip: ${masterIp})`
            this.logger.info(
                `instance (id:${this._selfInstance.instanceId}, ` +
                    `${logMessagMasterIp} is added to monitor at timestamp: ${Date.now()}.`
            )
            // if this newly come-up instance is the new master, save its instance id as the
            // default password into settings because all other instance will sync password from
            // the master there's a case if users never changed the master's password, when the
            // master was torn-down, there will be no way to retrieve this original password.
            // so in this case, should keep track of the update of default password.
            if (
                this._masterInfo &&
                this._selfInstance.instanceId === this._masterInfo.instanceId &&
                this.scalingGroupName === this.masterScalingGroupName
            ) {
                await this.platform.setSettingItem(
                    'fortigate-default-password',
                    this._selfInstance.instanceId,
                    'default password comes from the new elected master.',
                    false,
                    false
                )
            }
            return masterIp
                ? {
                      'master-ip': this._masterInfo.primaryPrivateIpAddress,
                  }
                : ''
        } else if (this._selfHealthCheck && this._selfHealthCheck.healthy) {
            // this instance is already in monitor. if the master has changed (i.e.: the current
            // master is different from the one this instance is holding), and the new master
            // is in a healthy state now, notify it by sending the new master ip to it.

            // if no master presents (reasons: waiting for the pending master instance to become
            // in-service; the master has been purged but no new master is elected yet.)
            // keep the calling instance 'in-sync'. don't update its master-ip.

            masterIp =
                this._masterInfo && this._masterHealthCheck && this._masterHealthCheck.healthy
                    ? this._masterInfo.primaryPrivateIpAddress
                    : this._selfHealthCheck.masterIp
            let now = Date.now()
            await this.platform.updateInstanceHealthCheck(
                this._selfHealthCheck,
                interval,
                masterIp,
                now,
                false,
                this.scalingGroupName
            )
            this.logger.info(
                `hb record updated on (timestamp: ${now}, instance id:` +
                    `${this._selfInstance.instanceId}, ` +
                    `ip: ${this._selfInstance.primaryPrivateIpAddress}) health check ` +
                    `(${this._selfHealthCheck.healthy ? 'healthy' : 'unhealthy'}, ` +
                    `heartBeatLossCount: ${this._selfHealthCheck.heartBeatLossCount}, ` +
                    `nextHeartBeatTime: ${this._selfHealthCheck.nextHeartBeatTime}` +
                    `syncState: ${this._selfHealthCheck.syncState}, master-ip: ${masterIp}).`
            )
            return masterIp && this._selfHealthCheck && this._selfHealthCheck.masterIp !== masterIp
                ? {
                      'master-ip': this._masterInfo.primaryPrivateIpAddress,
                  }
                : ''
        } else {
            this.logger.info(
                'instance is unhealthy. need to remove it. healthcheck record:',
                JSON.stringify(this._selfHealthCheck)
            )
            // for unhealthy instances, fail this instance
            // if it is previously on 'in-sync' state, mark it as 'out-of-sync' so script will stop
            // keeping it in sync and stop doing any other logics for it any longer.
            if (this._selfHealthCheck && this._selfHealthCheck.inSync) {
                // change its sync state to 'out of sync' by updating it state one last time
                await this.platform.updateInstanceHealthCheck(
                    this._selfHealthCheck,
                    interval,
                    this._selfHealthCheck.masterIp,
                    Date.now(),
                    true
                )
                // terminate it from autoscaling group
                await this.removeInstance(this._selfInstance)
            }
            // for unhealthy instances, keep responding with action 'shutdown'
            return {
                action: 'shutdown',
            }
        }
    }

    /**
     * Handle the status messages from FortiGate
     * @param {Object} event the incoming request event
     * @returns {Object} return messages
     */
    handleStatusMessage(event: {}) {
        this.logger.info('calling handleStatusMessage.')
        // do not process status messages till further requriements (Mar 27, 2019)
        this.logger.info(JSON.stringify(event))
        this.logger.info(`Status: ${this._requestInfo.status}`)
        return ''
    }

    /**
     * Parse a configset with given data sources. This function should be implemented in
     * a platform-specific one if needed.
     * @param {String} configSet a config string with placeholders. The placeholder looks like:
     * {@device.networkInterfaces#0.PrivateIpAddress}, where @ + device incidates the data source,
     * networkInterfaces + # + number incidates the nth item of networkInterfaces, so on and so
     * forth. The # index starts from 0. For referencing the 0th item, it can get rid of
     * the # + number, e.g. {@device.networkInterfaces#0.PrivateIpAddress} can be written as
     * {@device.networkInterfaces.PrivateIpAddress}
     * @param {Object} dataSources a json object of multiple key/value pairs with data
     * to relace some placeholders in the configSet parameter. Each key must start with an
     * asperand (@ symbol) to form a category of data such as: @vpc, @device, @vpn_connection, etc.
     * The value of each key must be an object {}. Each property of this object could be
     * a primitive, a nested object, or an array of the same type of primitives or nested object.
     * The leaf property of a nested object must be a primitive.
     * @returns {String} a pasred config string
     */
    abstract async parseConfigSet(configSet: string, parser: ConfigSetParser): Promise<string>

    /**
     * get master configuration
     * @param heartbeatSyncEndpoint the enpoint for heartbeat sync callback
     * @param moreConfigSets more configsets to parse here. parse each element
     * in their order in this array.
     */
    async getMasterConfig(
        heartbeatSyncEndpoint: URL,
        moreConfigSets?: ConfigSetParser[]
    ): Promise<string> {
        // no dollar sign in place holders
        let config = ''
        this._baseConfig = await this.getBaseConfig()
        // parse additional configsets
        if (moreConfigSets) {
            let self = this
            moreConfigSets.forEach(async parser => {
                config = await self.getConfigSet(parser.configsetName)
                config = await this.parseConfigSet(config, parser)
                this._baseConfig += config
            })
        }

        config = this._baseConfig.replace(/\{CALLBACK_URL}/, heartbeatSyncEndpoint.toString())
        return config
    }

    /**
     * get slave configuration
     * @param heartbeatSyncEndpoint the enpoint for heartbeat sync callback
     * @param allowHeadless allow this instance to boot up without masterIp specified
     * @param masterIp the ip address of the master instance to communicate with
     * @param moreConfigSets more configsets to parse here. parse each element
     * in their order in this array.
     */
    async getSlaveConfig(
        heartbeatSyncEndpoint: URL,
        allowHeadless: boolean,
        masterIp: string | null,
        moreConfigSets?: ConfigSetParser[]
    ): Promise<string> {
        this._baseConfig = await this.getBaseConfig()
        const autoScaleSectionMatch = AUTOSCALE_SECTION_EXPR.exec(this._baseConfig),
            autoScaleSection = autoScaleSectionMatch && autoScaleSectionMatch[1],
            matches = [
                /set\s+sync-interface\s+(.+)/.exec(autoScaleSection),
                /set\s+psksecret\s+(.+)/.exec(autoScaleSection),
            ]
        const [syncInterface, pskSecret] = matches.map(m => m && m[1]),
            apiEndpoint = heartbeatSyncEndpoint.toString()
        let config = '',
            errorMessage
        if (!apiEndpoint) {
            errorMessage = 'Api endpoint is missing'
        }
        if (masterIp === null && allowHeadless) {
            errorMessage = 'Master ip is missing'
        }
        if (!pskSecret) {
            errorMessage = 'psksecret is missing'
        }
        if (!pskSecret || !apiEndpoint || (masterIp === null && allowHeadless)) {
            throw new Error(
                `Base config is invalid (${errorMessage}): ${JSON.stringify({
                    syncInterface: syncInterface,
                    apiEndpoint: apiEndpoint,
                    masterIp: masterIp,
                    pskSecret: pskSecret && typeof pskSecret,
                })}`
            )
        }
        // parse additional configsets
        if (moreConfigSets) {
            let self = this
            moreConfigSets.forEach(async parser => {
                config = await self.getConfigSet(parser.configsetName)
                config = await this.parseConfigSet(config, parser)
                this._baseConfig += config
            })
        }
        const setMasterIp =
            masterIp === null && allowHeadless ? '' : `\n    set master-ip ${masterIp}`
        return await this._baseConfig
            .replace(new RegExp('set role master', 'gm'), `set role slave${setMasterIp}`)
            .replace(new RegExp('{CALLBACK_URL}', 'gm'), apiEndpoint)
    }

    async checkMasterElection(): Promise<VM | null> {
        this.logger.info('calling checkMasterElection')
        let needElection = false,
            purgeMaster = false,
            electionLock = false,
            electionComplete = false

        // reload the master
        await this.retrieveMaster(null, true)
        this.logger.info('current master healthcheck:', JSON.stringify(this._masterHealthCheck))
        // is there a master election done?
        // check the master record and its voteState
        // if there's a complete election, get master health check
        if (this._masterRecord && this._masterRecord.voteState === MasterElection.VoteState.done) {
            // if master is unhealthy, we need a new election
            if (
                !this._masterHealthCheck ||
                !this._masterHealthCheck.healthy ||
                !this._masterHealthCheck.inSync
            ) {
                purgeMaster = needElection = true
            } else {
                purgeMaster = needElection = false
            }
        } else if (
            this._masterRecord &&
            this._masterRecord.voteState === MasterElection.VoteState.pending
        ) {
            // if there's a pending master election, and if this election is incomplete by
            // the end-time, purge this election and starta new master election. otherwise, wait
            // until it's finished
            needElection = purgeMaster = Date.now() > this._masterRecord.voteEndTime
        } else {
            // if no master, try to hold a master election
            needElection = true
            purgeMaster = false
        }
        // if we need a new master, let's hold a master election!
        // 2019/01/14 add support for cross-scaling groups election
        // only instance comes from the masterScalingGroup can start an election
        // all other instances have to wait
        if (needElection) {
            // if i am in the master group, i can hold a master election
            if (this.scalingGroupName === this.masterScalingGroupName) {
                // can I run the election? (diagram: anyone's holding master election?)
                // try to put myself as the master candidate
                electionLock = await this.putMasterElectionVote(this._selfInstance, purgeMaster)
                if (electionLock) {
                    // yes, you run it!
                    this.logger.info(
                        `This instance (id: ${this._selfInstance.instanceId})` +
                            ' is running an election.'
                    )
                    try {
                        // (diagram: elect new master from queue (existing instances))
                        electionComplete = await this.electMaster()
                        this.logger.info(`Election completed: ${electionComplete}`)
                        // (diagram: master exists?)
                        this._masterRecord = null
                        this._masterInfo = electionComplete && (await this.getMasterInfo())
                    } catch (error) {
                        this.logger.error('Something went wrong in the master election.')
                    }
                }
            } else {
                // i am not in the master group, i am not allowed to hold a master election
                this.logger.info(
                    `This instance (id: ${this._selfInstance.instanceId}) not in ` +
                        'the master group, cannot hold election but wait for someone else to hold ' +
                        'an election.'
                )
            }
        }
        return Promise.resolve(this._masterInfo) // return the new master
    }

    /**
     * get the elected master instance info from the platform
     */
    async getMasterInfo(): Promise<VM> {
        this.logger.info('calling getMasterInfo')
        let instanceId
        try {
            this._masterRecord = this._masterRecord || (await this.platform.getMasterRecord())
            instanceId = this._masterRecord && this._masterRecord.instanceId
        } catch (ex) {
            this.logger.error(ex)
        }
        return (
            this._masterRecord &&
            (await this.platform.describeInstance(<VirtualMachineDescriptor>{
                instanceId: instanceId,
            }))
        )
    }

    /**
     * Submit an election vote for this ip address to become the master.
     * @param {Object} candidateInstance instance of the FortiGate which wants to become the master
     * @param {Object} purgeMasterRecord master record of the old master, if it's dead.
     */
    async putMasterElectionVote(
        candidateInstance: VM,
        purgeMasterRecord?: boolean
    ): Promise<boolean> {
        try {
            this.logger.log('masterElectionVote, purge master?', JSON.stringify(purgeMasterRecord))
            if (purgeMasterRecord) {
                try {
                    const purged = await this.purgeMaster()
                    this.logger.log('purged: ', purged)
                } catch (error) {
                    this.logger.log('no master purge')
                }
            } else {
                this.logger.log('no master purge')
            }
            return await this.platform.putMasterRecord(
                candidateInstance,
                MasterElection.VoteState.pending,
                MasterElection.VoteMethod.new
            )
        } catch (ex) {
            this.logger.warn(
                'exception while putMasterElectionVote',
                JSON.stringify(candidateInstance),
                JSON.stringify(purgeMasterRecord),
                ex.stack
            )
            return false
        }
    }

    /**
     * Do the master election
     * @returns {boolean} if election has been successfully completed
     */
    async electMaster() {
        // return the current master record
        return !!(await this.platform.getMasterRecord())
    }

    abstract async getFazIp(): Promise<string>

    // TODO: refactor the input and return type here
    abstract async handleNicAttachment(): Promise<boolean>

    // TODO: refactor the input and return type here
    abstract async handleNicDetachment(): Promise<boolean>

    async loadSubnetPairs() {
        return await this.platform.getSettingItem('subnets-pairs')
    }

    async saveSubnetPairs(subnetPairs: SubnetPair[]) {
        return await this.platform.setSettingItem('subnets-pairs', subnetPairs, null, true, false)
    }

    //TODO: I believe this was aws specific. If so could we add a comment and in the future
    // think about just moving it to the AWS code?
    async loadAutoScalingSettings() {
        let [desiredCapacity, minSize, maxSize, groupSetting] = await Promise.all([
            this.platform.getSettingItem('scaling-group-desired-capacity'),
            this.platform.getSettingItem('scaling-group-min-size'),
            this.platform.getSettingItem('scaling-group-max-size'),
            this.platform.getSettingItem('auto-scaling-group'),
        ])

        if (!(desiredCapacity && minSize && maxSize) && groupSetting) {
            return groupSetting
        }
        return { desiredCapacity: desiredCapacity, minSize: minSize, maxSize: maxSize }
    }

    async loadSettings() {
        if (!(this._settings && Object.keys(this._settings).length > 0)) {
            await this.platform.getSettingItems() // initialize the platform settings
        }
        return this._settings
    }

    /**
     * Save settings to DB. This function doesn't do value validation. The caller should be
     * responsible for it.
     * @param {Object} settings settings to save
     */
    // TODO: use Map type for the settings parameter.
    async saveSettings(settings: { [key: string]: any}) {
        let tasks = [],
            errorTasks = []
        for (let [key, value] of Object.entries(settings)) {
            let keyName: string | null = null,
                description: string | null = null,
                jsonEncoded: boolean = false,
                editable: boolean = false
            switch (key.toLowerCase()) {
                case 'servicetype':
                    // ignore service type
                    break
                case 'deploymentsettingssaved':
                    keyName = 'deployment-settings-saved'
                    description =
                        'A flag setting item that indicates all deployment ' +
                        'settings have been saved.'
                    editable = false
                    break
                case 'byolscalinggroupdesiredcapacity':
                    keyName = 'byol-scaling-group-desired-capacity'
                    description = 'BYOL Scaling group desired capacity.'
                    editable = true
                    break
                case 'byolscalinggroupminsize':
                    keyName = 'byol-scaling-group-min-size'
                    description = 'BYOL Scaling group min size.'
                    editable = true
                    break
                case 'byolscalinggroupmaxsize':
                    keyName = 'byol-scaling-group-max-size'
                    description = 'BYOL Scaling group max size.'
                    editable = true
                    break
                case 'scalinggroupdesiredcapacity':
                    keyName = 'scaling-group-desired-capacity'
                    description = 'PAYG Scaling group desired capacity.'
                    editable = true
                    break
                case 'scalinggroupminsize':
                    keyName = 'scaling-group-min-size'
                    description = 'PAYG Scaling group min size.'
                    editable = true
                    break
                case 'scalinggroupmaxsize':
                    keyName = 'scaling-group-max-size'
                    description = 'PAYG Scaling group max size.'
                    editable = true
                    break
                case 'resourcetagprefix':
                    keyName = 'resource-tag-prefix'
                    description = 'Resource tag prefix.'
                    editable = false
                    break
                case 'customidentifier':
                    keyName = 'custom-id'
                    description = 'Custom Identifier.'
                    editable = false
                    break
                case 'uniqueid':
                    keyName = 'unique-id'
                    description = 'Unique ID.'
                    editable = false
                    break
                case 'assetstoragename':
                    keyName = 'asset-storage-name'
                    description = 'Asset storage name.'
                    editable = false
                    break
                case 'assetstoragekeyprefix':
                    keyName = 'asset-storage-key-prefix'
                    description = 'Asset storage key prefix.'
                    editable = false
                    break
                case 'fortigateautoscalevpcid':
                    keyName = 'fortigate-autoscale-vpc-id'
                    description = 'VPC ID of the FortiGate Autoscale.'
                    editable = false
                    break
                case 'fortigateautoscalesubnet1':
                    keyName = 'fortigate-autoscale-subnet-1'
                    description =
                        'The ID of the subnet 1 (in the first selected AZ) ' +
                        'of the FortiGate Autoscale.'
                    editable = false
                    break
                case 'fortigateautoscalesubnet2':
                    keyName = 'fortigate-autoscale-subnet-2'
                    description =
                        'The ID of the subnet 2 (in the second selected AZ) ' +
                        'of the FortiGate Autoscale.'
                    editable = false
                    break
                case 'fortigateautoscaleprotectedsubnet1':
                    keyName = 'fortigate-autoscale-protected-subnet1'
                    description =
                        'The ID of the protected subnet 1 (in the first selected AZ) ' +
                        'of the FortiGate Autoscale.'
                    editable = true
                    break
                case 'fortigateautoscaleprotectedsubnet2':
                    keyName = 'fortigate-autoscale-protected-subnet2'
                    description =
                        'The ID of the protected subnet 2 (in the second selected AZ) ' +
                        'of the FortiGate Autoscale.'
                    editable = true
                    break
                case 'fortigatepsksecret':
                    keyName = 'fortigate-psk-secret'
                    description = 'The PSK for FortiGate Autoscale Synchronization.'
                    break
                case 'fortigateadminport':
                    keyName = 'fortigate-admin-port'
                    description = 'The port number for administrative login to FortiGate.'
                    break
                case 'fortigatetrafficport':
                    keyName = 'fortigate-traffic-port'
                    description =
                        'The port number for load balancer to route traffic through ' +
                        'FortiGate to the protected services behind the load balancer.'
                    break
                case 'fortigatesyncinterface':
                    keyName = 'fortigate-sync-interface'
                    description =
                        'The interface the FortiGate uses for configuration ' + 'synchronization.'
                    editable = true
                    break
                case 'lifecyclehooktimeout':
                    keyName = 'lifecycle-hook-timeout'
                    description = 'The auto scaling group lifecycle hook timeout time in second.'
                    editable = true
                    break
                case 'heartbeatinterval':
                    keyName = 'heartbeat-interval'
                    description = 'The FortiGate sync heartbeat interval in second.'
                    editable = true
                    break
                case 'masterelectiontimeout':
                    keyName = 'master-election-timeout'
                    description = 'The FortiGate master election timtout time in second.'
                    editable = true
                    break
                case 'masterelectionnowait':
                    keyName = 'master-election-no-wait'
                    description =
                        'Do not wait for the new master to come up. This FortiGate ' +
                        'can receive the new master ip in one of its following heartbeat sync.'
                    editable = true
                    break
                case 'heartbeatlosscount':
                    keyName = 'heartbeat-loss-count'
                    description = 'The FortiGate sync heartbeat loss count.'
                    editable = true
                    break
                case 'heartbeatdelayallowance':
                    keyName = 'heartbeat-delay-allowance'
                    description = 'The FortiGate sync heartbeat delay allowance time in second.'
                    editable = true
                    break
                case 'autoscalehandlerurl':
                    keyName = 'autoscale-handler-url'
                    description = 'The FortiGate Autoscale handler URL.'
                    editable = false
                    break
                case 'masterscalinggroupname':
                    keyName = 'master-scaling-group-name'
                    description = 'The name of the master auto scaling group.'
                    editable = false
                    break
                case 'paygscalinggroupname':
                    keyName = 'payg-scaling-group-name'
                    description = 'The name of the PAYG auto scaling group.'
                    editable = false
                    break
                case 'byolscalinggroupname':
                    keyName = 'byol-scaling-group-name'
                    description = 'The name of the BYOL auto scaling group.'
                    editable = false
                    break
                case 'requiredconfigset':
                    keyName = 'required-configset'
                    description = 'A comma-delimited list of required configsets.'
                    editable = false
                    break
                case 'requireddbtable':
                    keyName = 'required-db-table'
                    description = 'A comma-delimited list of required DB table names.'
                    editable = false
                    break
                case 'transitgatewayid':
                    keyName = 'transit-gateway-id'
                    description =
                        'The ID of the Transit Gateway the FortiGate Autoscale is ' + 'attached to.'
                    editable = false
                    break
                case 'enabletransitgatewayvpn':
                    keyName = 'enable-transit-gateway-vpn'
                    value = value && value !== 'false' ? 'true' : 'false'
                    description =
                        'Toggle ON / OFF the Transit Gateway VPN creation on each ' +
                        'FortiGate instance'
                    editable = false
                    break
                case 'enablesecondnic':
                    keyName = 'enable-second-nic'
                    value = value && value !== 'false' ? 'true' : 'false'
                    description =
                        'Toggle ON / OFF the secondary eni creation on each ' + 'FortiGate instance'
                    editable = false
                    break
                case 'bgpasn':
                    keyName = 'bgp-asn'
                    description =
                        'The BGP Autonomous System Number of the Customer Gateway ' +
                        'of each FortiGate instance in the Auto Scaling Group.'
                    editable = true
                    break
                case 'transitgatewayvpnhandlername':
                    keyName = 'transit-gateway-vpn-handler-name'
                    description = 'The Transit Gateway VPN handler function name.'
                    editable = false
                    break
                case 'transitgatewayroutetableinbound':
                    keyName = 'transit-gateway-route-table-inbound'
                    description = 'The Id of the Transit Gateway inbound route table.'
                    editable = true
                    break
                case 'transitgatewayroutetableoutbound':
                    keyName = 'transit-gateway-route-table-outbound'
                    description = 'The Id of the Transit Gateway outbound route table.'
                    break
                case 'enablehybridlicensing':
                    keyName = 'enable-hybrid-licensing'
                    description = 'Toggle ON / OFF the hybrid licensing feature.'
                    editable = false
                    break
                case 'enablefortigateelb':
                    keyName = 'enable-fortigate-elb'
                    description =
                        'Toggle ON / OFF the elastic load balancing for the FortiGate ' +
                        'scaling groups.'
                    editable = false
                    break
                case 'enableinternalelb':
                    keyName = 'enable-internal-elb'
                    description =
                        'Toggle ON / OFF the internal elastic load balancing for ' +
                        'the protected services by FortiGate.'
                    editable = true
                    break
                case 'fortigateautoscaleelbdns':
                    keyName = 'fortigate-autoscale-elb-dns'
                    description =
                        'The DNS name of the elastic load balancer for the FortiGate ' +
                        'scaling groups.'
                    editable = false
                    break
                case 'fortigateautoscaletargetgrouparn':
                    keyName = 'fortigate-autoscale-target-group-arn'
                    description =
                        'The ARN of the target group for FortiGate to receive ' +
                        'load balanced traffic.'
                    editable = false
                    break
                case 'fortigateprotectedinternalelbdns':
                    keyName = 'fortigate-protected-internal-elb-dns'
                    description =
                        'The DNS name of the elastic load balancer for the scaling ' +
                        'groups of services protected by FortiGate'
                    editable = true
                    break
                case 'enabledynamicnatgateway':
                    keyName = 'enable-dynamic-nat-gateway'
                    description = 'Toggle ON / OFF the dynamic NAT gateway feature.'
                    editable = true
                    break
                case 'dynamicnatgatewayroutetables':
                    keyName = 'dynamic-nat-gateway-route-tables'
                    description = 'The dynamic NAT gateway managed route tables.'
                    editable = true
                    break
                case 'enablevminfocache':
                    keyName = 'enable-vm-info-cache'
                    description =
                        'Toggle ON / OFF the vm info cache feature. It caches the ' +
                        'vm info in db to reduce API calls to query a vm from the platform.'
                    editable = true
                    break
                case 'vminfocachetime':
                    keyName = 'vm-info-cache-time'
                    description = 'The vm info cache time in seconds.'
                    editable = true
                    break
                case 'fortigatelicensestoragekeyprefix':
                    keyName = 'fortigate-license-storage-key-prefix'
                    description = 'The key prefix for FortiGate licenses in the access storage.'
                    editable = true
                    break
                case 'getlicensegraceperiod':
                    keyName = 'get-license-grace-period'
                    description =
                        'The period (time in seconds) for preventing a newly assigned ' +
                        ' license to be recycled.'
                    editable = true
                    break
                default:
                    break
            }
            if (keyName) {
                tasks.push(
                    this.platform
                        .setSettingItem(keyName, value, description, jsonEncoded, editable)
                        .catch(error => {
                            this.logger.error(
                                `failed to save setting for key: ${keyName}. ` +
                                    `Error: ${JSON.stringify(error)}`
                            )
                            errorTasks.push({ key: keyName, value: value })
                        })
                )
            }
        }
        await Promise.all(tasks)
        return errorTasks.length === 0
    }

    // TODO: restrict the parameter type to number only
    abstract async updateCapacity(
        scalingGroupName: string,
        desiredCapacity: number | null,
        minSize: number | null,
        maxSize: number | null
    ): Promise<boolean>

    /**
     * check state of one scaling groups
     * @param scalingGroupName scaling group name
     */
    abstract async checkAutoScalingGroupState(scalingGroupName: string): Promise<ScalingGroupState|string>

    async resetMasterElection() {
        this.logger.info('calling resetMasterElection')
        try {
            this.setScalingGroup(
                this._settings['master-scaling-group-name'] &&
                    this._settings['master-scaling-group-name'].toString(),
                null
            )
            await this.platform.removeMasterRecord()
            this.logger.info('called resetMasterElection. done.')
            return true
        } catch (error) {
            this.logger.info('called resetMasterElection. failed.', error)
            return false
        }
    }

    // TODO: restrict the heartBeatInterval to type: number only
    abstract async addInstanceToMonitor(
        instance: VM,
        heartBeatInterval: ValidHeartbeatInterval,
        masterIp?: string
    ): Promise<boolean>

    async removeInstanceFromMonitor(instanceId: string) {
        this.logger.info('calling removeInstanceFromMonitor')
        return await this.platform.deleteInstanceHealthCheck(instanceId, this.scalingGroupName)
    }

    /**
     *
     * @param filters accepted filter key: masterInfo, masterHealthCheck, or masterRecord
     * @param reload
     */
    async retrieveMaster(
        filters: Map<RetrieveMasterOption, boolean> | null = null,
        reload = false
    ): Promise<{
        masterInfo: VM | null
        masterHealthCheck: HealthCheck | null
        masterRecord: MasterElection.MasterRecord | null
    }> {
        if (reload) {
            this._masterInfo = null
            this._masterHealthCheck = null
            this._masterRecord = null
        }
        if (
            filters === null ||
            filters.get(RetrieveMasterOption.masterInfo) ||
            filters.get(RetrieveMasterOption.masterHealthCheck)
        ) {
            // if reload not needed, return the current object or retrive it.
            this._masterInfo = (!reload && this._masterInfo) || (await this.getMasterInfo())
        }

        if (this._masterInfo &&
            (filters === null || filters.get(RetrieveMasterOption.masterHealthCheck))) {
            // if reload not needed, return the current object or retrive it.
            this._masterHealthCheck =
                (!reload && this._masterHealthCheck) ||
                (await this.platform.getInstanceHealthCheck(<VirtualMachineDescriptor>{
                    instanceId: this._masterInfo.instanceId,
                }))
        }

        if (filters === null || filters.get(RetrieveMasterOption.masterRecord)) {
            // if reload not needed, return the current object or retrive it.
            this._masterRecord =
                (!reload && this._masterRecord) || (await this.platform.getMasterRecord())
        }

        return {
            masterInfo: this._masterInfo,
            masterHealthCheck: this._masterHealthCheck,
            masterRecord: this._masterRecord,
        }
    }

    async purgeMaster() {
        // TODO: double check that the work flow of terminating the master instance here
        // is appropriate
        try {
            let asyncTasks: Promise<any>[] = []
            await this.retrieveMaster()
            // if has master health check record, make it out-of-sync
            if (this._masterInfo && this._masterHealthCheck) {
                asyncTasks.push(
                    this.platform.updateInstanceHealthCheck(
                        this._masterHealthCheck,
                        AutoscaleHandler.NO_HEART_BEAT_INTERVAL_SPECIFIED,
                        this._masterInfo.primaryPrivateIpAddress,
                        Date.now(),
                        true
                    )
                )
            }
            asyncTasks.push(
                this.platform.removeMasterRecord(),
                this.removeInstance(this._masterInfo)
            )
            let result = await Promise.all(asyncTasks)
            return !!result
        } catch (error) {
            this.logger.error('called purgeMaster > error: ', JSON.stringify(error))
            return false
        }
    }

    abstract async removeInstance(instance: VM): Promise<boolean>

    setScalingGroup(master: string | null, self: string | null) {
        if (master) {
            this.platform.masterScalingGroupName = master
        }
        if (self) {
            this.scalingGroupName = self
        }
    }

    /**
     *
     * @param licenseFiles a map of LicenseItem based on
     * the license files in the blob storage. Each map key is the 'blobKey' of the LicenseItem.
     * @param {Map<String, LicenseRecord>} existingRecords a map of LicenseRecord based on
     * the existing license record in the db. Each map key is the 'checksum' of the LicenseItem.
     */

    // TODO: there are new changes in the feature/hybrid_licensing_support branch after merged.
    // remember to merge those changes here.
    async updateLicenseStockRecord(
        licenseFiles: Map<string, LicenseItem>,
        existingRecords: Map<string, LicenseRecord>
    ): Promise<Map<string, LicenseRecord>> {
        if (licenseFiles instanceof Map && existingRecords instanceof Map) {
            let untrackedFiles = new Map(licenseFiles.entries()) // copy the map
            let recordsToDelete = new Map()
            try {
                if (existingRecords.size > 0) {
                    // filter out tracked license files
                    // if the tracked record doesn't match any file (may be deleted?), delete the
                    // record
                    existingRecords.forEach(licenseRecord => {
                        if (licenseFiles.has(licenseRecord.blobKey)) {
                            untrackedFiles.delete(licenseRecord.blobKey)
                        } else {
                            recordsToDelete.set(licenseRecord.checksum, licenseRecord)
                        }
                    }, this)
                }
                let platform = this.platform,
                    logger = this.logger
                // fetch the content for each untrack license file
                let updateTasks: Promise<any>[] = [],
                    updateTasksResult: LicenseItem[],
                    doneTaskCount = 0

                if (recordsToDelete.size > 0) {
                    recordsToDelete.forEach(licenseRecord => {
                        updateTasks.push(
                            platform
                                .deleteLicenseStock(licenseRecord)
                                .then(() => {
                                    logger.info(
                                        `remove license file (${licenseRecord.fileName}) ` +
                                            'from stock.'
                                    )
                                    return true
                                })
                                .catch((error: any) => {
                                    logger.error(
                                        'cannot remove license file ' +
                                            `(${licenseRecord.fileName}) from stock. ` +
                                            `error: ${JSON.stringify(error)}`
                                    )
                                    return false
                                })
                        )
                    })

                    await Promise.all(updateTasks).then(doneTasks => {
                        doneTaskCount = 0
                        doneTasks.forEach(done => (doneTaskCount = done && doneTaskCount + 1))
                        return doneTaskCount
                    })

                    if (doneTaskCount > 0) {
                        logger.info(`${doneTaskCount} files removed from stock.`)
                    }
                }

                if (untrackedFiles.size > 0) {
                    untrackedFiles.forEach(licenseItem => {
                        if (!licenseItem.content) {
                            updateTasks.push(
                                platform
                                    .getLicenseFileContent(<BlobStorageItemDescriptor>{
                                        storageName: this._settings[
                                            'asset-storage-name'
                                        ].toString(),
                                        keyPrefix: path.join(
                                            this._settings['asset-storage-key-prefix'].toString(),
                                            this._settings[
                                                'fortigate-license-storage-key-prefix'
                                            ].toString()
                                        ),
                                        fileName: licenseItem.fileName,
                                    })
                                    .then(content => {
                                        licenseItem.content = content
                                        return licenseItem
                                    })
                                    .catch(error => {
                                        logger.error(
                                            'cannot get the content of license file ' +
                                                `(${licenseItem.fileName}). ` +
                                                `error: ${JSON.stringify(error)}`
                                        )
                                        return null
                                    })
                            )
                        } else {
                            updateTasks.push(Promise.resolve(licenseItem))
                        }
                    })

                    updateTasksResult = await Promise.all(updateTasks).then(
                        (result: LicenseItem[]) => {
                            return result
                        }
                    )
                    untrackedFiles = new Map(
                        updateTasksResult
                            .filter(licenseItem => {
                                return !!licenseItem
                            })
                            .map(licenseItem => {
                                return [licenseItem.checksum, licenseItem]
                            })
                    )
                }

                if (untrackedFiles.size > 0) {
                    updateTasks = []
                    untrackedFiles.forEach(licenseItem => {
                        if (existingRecords.has(licenseItem.checksum)) {
                            logger.warn(
                                'updateLicenseStockRecord > warning: duplicate' +
                                    ` license found: filename: ${licenseItem.fileName}`
                            )
                            return licenseItem
                        } else {
                            updateTasks.push(
                                platform
                                    .updateLicenseStock(licenseItem, false)
                                    .then(() => {
                                        logger.info(
                                            `added license file (${licenseItem.fileName}) ` +
                                                'to stock.'
                                        )
                                        return licenseItem
                                    })
                                    .catch(error => {
                                        logger.error(
                                            'cannot add license file ' +
                                                `(${licenseItem.fileName}) to stock. ` +
                                                `error: ${JSON.stringify(error)}`
                                        )
                                        logger.error(error)
                                    })
                            )
                            return null
                        }
                    })
                    updateTasksResult = await Promise.all(updateTasks)
                    untrackedFiles = new Map(
                        updateTasksResult
                            .filter(licenseItem => {
                                return !!licenseItem
                            })
                            .map(licenseItem => {
                                return [licenseItem.checksum, licenseItem]
                            })
                    )
                }

                return (
                    ((untrackedFiles.size > 0 || recordsToDelete.size > 0) &&
                        this.platform.listLicenseStock()) ||
                    existingRecords
                )
            } catch (error) {
                // NOTE: throw the error out here? or catch it? then what should return when error?
                this.logger.error(error)
                throw error
            }
        } else {
            return existingRecords
        }
    }

    // TODO: this should be called in the lamba function implementation
    // FIXME: this function is intended for handling AWS lifecycle events. move to AWS library,
    // not need to be abstract
    abstract async handleAutoScalingEvent(event?: unknown): Promise<ErrorDataPairLike>

    // TODO: this should be called in the lamba function implementation
    abstract async handleGetConfig(event?: unknown): Promise<ErrorDataPairLike>

    /**
     * To handle and move on the lifecycle to its next stage
     * Autoscaling lifecycle and stages may exist in some platforms only.
     * Could implement this function with an empty function on other platforms.
     * @param instanceId id of instance in the lifecycle
     * @param action the lifecycle action
     * @param fulfilled lifecycle action is satisified as desired or not
     */
    // FIXME: this function is intended for handling AWS lifecycle events. move to AWS library,
    // not need to be abstract
    abstract async handleLifecycleAction(
        instanceId: string,
        action: LifecycleAction,
        fulfilled: boolean
    ): Promise<boolean>

    /**
     * Find a recyclable license from those been previously used by a device but now the device
     * has become unavailable. Hence, the license it was assigned can be recycled.
     * @param {Map<licenseRecord>} stockRecords the stock records to compare with
     * @param {Map<licenseRecord>} usageRecords the usage records to compare with
     * @param {Number} limit find how many items? set to a negative number for no limit
     * @returns {Array<licenseRecord>} must return an Array of licenseRecord with checksum as key,
     * and LicenseItem as value
     */
    abstract async findRecyclableLicense(
        stockRecords: Map<string, LicenseRecord>,
        usageRecords: Map<string, LicenseRecord>,
        limit?: number | 'all'
    ): Promise<LicenseRecord[]>

    /**
     * Check and update the route to the NAT gateway instance (which is one healthy ForitGate
     * from the scaling groups)
     */
    abstract async updateNatGatewayRoute(): Promise<void>
}
