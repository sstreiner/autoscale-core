// the no-shadow rule errored in the next line may be just a false alarm
// eslint-disable-next-line no-shadow
export enum HealthCheckSyncState {
    InSync = 'in-sync',
    OutOfSync = 'out-of-sync'
}
export interface HealthCheckRecord {
    vmId: string;
    scalingGroupName: string;
    ip: string;
    primaryIp: string;
    heartbeatInterval: number;
    heartbeatLossCount: number;
    nextHeartbeatTime: number;
    syncState: HealthCheckSyncState;
    syncRecoveryCount: number;
    seq: number;
    healthy: boolean;
    upToDate: boolean;
    sendTime: string;
    deviceSyncTime: string;
    deviceSyncFailTime: string;
    deviceSyncStatus: boolean | null;
    deviceIsPrimary: boolean | null;
    deviceChecksum: string;
}

// the no-shadow rule errored in the next line may be just a false alarm
// eslint-disable-next-line no-shadow
export enum HealthCheckResult {
    OnTime = 'on-time',
    Late = 'late',
    TooLate = 'too-late',
    Dropped = 'dropped',
    Recovering = 'recovering',
    Recovered = 'recovered'
}

export interface HealthCheckResultDetail {
    sequence: number;
    result: HealthCheckResult;
    expectedArriveTime: number;
    actualArriveTime: number;
    heartbeatInterval: number;
    oldHeartbeatInerval: number;
    delayAllowance: number;
    calculatedDelay: number;
    actualDelay: number;
    heartbeatLossCount: number;
    maxHeartbeatLossCount: number;
    syncRecoveryCount: number;
    maxSyncRecoveryCount: number;
}

// the no-shadow rule errored in the next line may be just a false alarm
// eslint-disable-next-line no-shadow
export enum PrimaryRecordVoteState {
    Pending = 'pending',
    Done = 'done',
    Timeout = 'timeout'
}

export interface PrimaryRecord {
    id: string;
    vmId: string;
    ip: string;
    scalingGroupName: string;
    virtualNetworkId: string;
    subnetId: string;
    voteEndTime: number;
    voteState: PrimaryRecordVoteState;
}
