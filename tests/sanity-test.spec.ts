import { describe, it } from 'mocha';
import * as Sinon from 'sinon';
import {
    Autoscale,
    PlatformAdapter,
    ReqType,
    VirtualMachine,
    HealthCheckRecord,
    MasterRecord,
    VmDescriptor,
    AutoscaleEnvironment,
    CloudFunctionProxyAdapter,
    CloudFunctionResponseBody,
    LogLevel,
    HealthCheckSyncState,
    HeartbeatSyncTiming,
    MasterRecordVoteState,
    MasterElectionStrategy,
    MasterElection
} from '../autoscale-core';
import { Settings, SettingItem, AutoscaleSetting } from '../autoscale-setting';

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const TEST_HCR: HealthCheckRecord = {
    instanceId: '1',
    ip: '2',
    masterIp: '3',
    heartbeatInterval: 4,
    heartbeatLossCount: 5,
    nextHeartbeatCheckTime: 6,
    syncState: HealthCheckSyncState.InSync,
    healthy: true,
    inSync: true
};

const TEST_VM: VirtualMachine = {
    instanceId: '1',
    scalingGroupName: '2',
    primaryPrivateIpAddress: '3',
    primaryPublicIpAddress: '4',
    virtualNetworkId: '5',
    subnetId: '6'
};

const TEST_MASTER_RECORD: MasterRecord = {
    id: '1',
    instanceId: '2',
    ip: '3',
    scalingGroupName: '4',
    virtualNetworkId: '5',
    subnetId: '6',
    voteEndTime: 7,
    voteState: MasterRecordVoteState.Done
};

const TEST_MASTER_ELECTION: MasterElection = {
    newMaster: TEST_VM,
    newMasterRecord: TEST_MASTER_RECORD,
    candidate: TEST_VM,
    signature: '12345'
};

class TestPlatformAdapter implements PlatformAdapter {
    adaptee: {};
    getRequestType(): ReqType {
        throw new Error('Method not implemented.');
    }
    getReqHeartbeatInterval(): number {
        throw new Error('Method not implemented.');
    }
    getSettings(): Settings {
        throw new Error('Method not implemented.');
    }
    getTargetVm(): Promise<VirtualMachine> {
        return Promise.resolve(TEST_VM);
    }
    getMasterVm(): Promise<VirtualMachine> {
        throw new Error('Method not implemented.');
    }
    getHealthCheckRecord(vm: VirtualMachine): Promise<HealthCheckRecord> {
        return Promise.resolve(TEST_HCR);
    }
    getMasterRecord(): Promise<MasterRecord> {
        throw new Error('Method not implemented.');
    }
    equalToVm(vmA: VirtualMachine, vmB: VirtualMachine): boolean {
        throw new Error('Method not implemented.');
    }
    describeVm(desc: VmDescriptor): Promise<VirtualMachine> {
        throw new Error('Method not implemented.');
    }
    deleteVm(vm: VirtualMachine): Promise<void> {
        throw new Error('Method not implemented.');
    }
    createHealthCheckRecord(rec: HealthCheckRecord): Promise<void> {
        throw new Error('Method not implemented.');
    }
    updateHealthCheckRecord(rec: HealthCheckRecord): Promise<void> {
        throw new Error('Method not implemented.');
    }
    createMasterRecord(rec: MasterRecord, oldRec: MasterRecord): Promise<void> {
        throw new Error('Method not implemented.');
    }
    updateMasterRecord(rec: MasterRecord): Promise<void> {
        throw new Error('Method not implemented.');
    }
}

class TestCloudFunctionProxyAdapter implements CloudFunctionProxyAdapter {
    formatResponse(httpStatusCode: number, body: CloudFunctionResponseBody, headers: {}): {} {
        throw new Error('Method not implemented.');
    }
    log(message: string, level: LogLevel): void {
        throw new Error('Method not implemented.');
    }
    logAsDebug(message: string): void {
        throw new Error('Method not implemented.');
    }
    logAsInfo(message: string): void {
        throw new Error('Method not implemented.');
    }
    logAsWarning(message: string): void {
        throw new Error('Method not implemented.');
    }
    logAsError(message: string): void {
        throw new Error('Method not implemented.');
    }
    logForError(messagePrefix: string, error: Error): void {
        throw new Error('Method not implemented.');
    }
}

describe('sanity test', () => {
    let p: TestPlatformAdapter;
    let e: AutoscaleEnvironment;
    let x: TestCloudFunctionProxyAdapter;
    let s: Settings;
    let si: SettingItem;
    let ms: MasterElectionStrategy;
    let autoscale: Autoscale;
    before(function() {
        p = new TestPlatformAdapter();
        e = {
            targetVm: TEST_VM,
            masterVm: TEST_VM,
            masterRecord: TEST_MASTER_RECORD
        };
        x = new TestCloudFunctionProxyAdapter();
        si = {
            key: '1',
            value: '2',
            description: '3',
            editable: true,
            jsonEncoded: false,
            toJSON() {
                return {};
            }
        };
        s = new Map<string, SettingItem>();
        s.set(AutoscaleSetting.MasterElectionTimeout, si);
        ms = {
            prepare() {
                return Promise.resolve();
            },
            apply() {
                return Promise.resolve('');
            },
            result() {
                return Promise.resolve(TEST_MASTER_ELECTION);
            }
        };
        autoscale = new Autoscale(p, e, x, s);
        autoscale.setMasterElectionStrategy(ms);
    });
    it('handleMasterElection', async () => {
        const stub1 = Sinon.stub(x, 'logAsInfo');
        const stub2 = Sinon.stub(p, 'getSettings').callsFake(() => {
            return s;
        });
        const stub3 = Sinon.stub(ms, 'prepare').callsFake((ms1, p1, x1) => {
            Sinon.assert.match(ms1.candidate, TEST_VM);
            Sinon.assert.match(Object.is(p1, p), true);
            Sinon.assert.match(Object.is(x1, x), true);
            return Promise.resolve();
        });
        const stub4 = Sinon.stub(ms, 'apply');
        const stub5 = Sinon.stub(ms, 'result').callsFake(() => {
            return Promise.resolve(TEST_MASTER_ELECTION);
        });
        try {
            const result = await autoscale.handleMasterElection();
            Sinon.assert.match(stub1.called, true);
            Sinon.assert.match(await stub2.returnValues[0], s);
            Sinon.assert.match(stub3.called, true);
            Sinon.assert.match(stub4.notCalled, true);
            Sinon.assert.match(stub5.called, true);
            Sinon.assert.match(result, '');
        } catch (error) {
            console.log(error);
            Sinon.assert.fail('should not throw errors.');
        } finally {
            stub1.restore();
            stub2.restore();
            stub3.restore();
            stub4.restore();
            stub5.restore();
        }
    });
    it('handleHeartbeatSync', async () => {
        const stub1 = Sinon.stub(p, 'getHealthCheckRecord').callsFake(input => {
            Sinon.assert.match(Object.is(input, TEST_VM), true);
            return Promise.resolve(TEST_HCR);
        });
        const stub2 = Sinon.stub(p, 'getTargetVm');
        const stub3 = Sinon.stub(autoscale, 'handleLaunchedVm').callsFake(() => {
            return Promise.resolve('Sinon.stub.callsFake');
        });
        const stub4 = Sinon.stub(autoscale, 'doTargetHealthCheck').callsFake(() => {
            return Promise.resolve(HeartbeatSyncTiming.OnTime);
        });
        const stub5 = Sinon.stub(p, 'getMasterVm').callsFake(() => {
            return Promise.resolve(TEST_VM);
        });
        const stub6 = Sinon.stub(p, 'getMasterRecord').callsFake(() => {
            return Promise.resolve(TEST_MASTER_RECORD);
        });
        const stub7 = Sinon.stub(autoscale, 'handleMasterElection').callsFake(() => {
            return Promise.resolve('Sinon.stub.callsFake');
        });
        const stub8 = Sinon.stub(autoscale, 'handleTaggingVm');
        const stub9 = Sinon.stub(p, 'equalToVm').callsFake((a, b) => {
            Sinon.assert.match(a, TEST_VM);
            Sinon.assert.match(b, TEST_VM);
            return true;
        });
        const stub10 = Sinon.stub(p, 'updateHealthCheckRecord').callsFake(hcr => {
            Sinon.assert.match(Object.is(hcr, TEST_HCR), true);
            return Promise.resolve();
        });

        try {
            const result = await autoscale.handleHeartbeatSync();
            Sinon.assert.match(await stub1.returnValues[0], TEST_HCR);
            Sinon.assert.match(stub2.notCalled, true);
            Sinon.assert.match(stub3.notCalled, true);
            Sinon.assert.match(await stub4.returnValues[0], HeartbeatSyncTiming.OnTime);
            Sinon.assert.match(stub5.notCalled, true);
            Sinon.assert.match(await stub6.notCalled, true);
            Sinon.assert.match(await stub7.returnValues[0], 'Sinon.stub.callsFake');
            Sinon.assert.match(stub8.called, true);
            Sinon.assert.match(stub9.called, true);
            Sinon.assert.match(stub10.called, true);
            Sinon.assert.match(result, '');
        } catch (error) {
            console.log(error);
            Sinon.assert.fail('should not throw errors.');
        } finally {
            stub1.restore();
            stub2.restore();
            stub3.restore();
            stub4.restore();
            stub5.restore();
            stub6.restore();
            stub7.restore();
            stub8.restore();
            stub9.restore();
            stub10.restore();
        }
    });
});
