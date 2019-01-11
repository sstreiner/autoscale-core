'use strict';

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

const Logger = require('./logger');
const
    AUTOSCALE_SECTION_EXPR =
    /(?:^|\n)\s*config?\s*system?\s*auto-scale[\s\n]*((?:.|\n)*)\bend\b/,
    SET_SECRET_EXPR = /(set\s+(?:psksecret|password)\s+).*/g;

module.exports = class AutoscaleHandler {

    constructor(platform, baseConfig) {
        this.platform = platform;
        this._baseConfig = baseConfig;
        this._selfInstance = null;
        this._masterRecord = null;
    }

    /**
     * Set the logger to output log to platform
     * @param {Logger} logger Logger object used to output log to platform
     */
    useLogger(logger) {
        this.logger = logger || new Logger();
    }

    throwNotImplementedException() {
        throw new Error('Not Implemented');
    }

    async handle() {
        await this.throwNotImplementedException();
    }

    async init() {
        const success = await this.platform.init();
        // retrieve base config from an S3 bucket
        this._baseConfig = await this.getBaseConfig();
        return success;
    }

    async getConfigSet(configName) {
        try {
            const parameters = {
                path: 'configset',
                configName: configName
            };
            return await this.platform.getBlobFromStorage(parameters);
        } catch (error) {
            this.logger.warn(`called getConfigSet > error: ${error}`);
            throw error;
        }
    }

    async getConfig(ip) {
        await this.throwNotImplementedException();
        return ip;
    }

    /**
     * Handle the 'auto-scale synced' callback from the FortiGate.
     * @param {*} event event from the handling call. structure varies per platform.
     */
    async handleSyncedCallback(event) {
        const { instanceId, interval, status } =
            this.platform.extractRequestInfo(event),
            statusSuccess = status && status === 'success' || false;
        // if fortigate is sending callback in response to obtaining config, this is a state
        // message
        let parameters = {}, selfHealthCheck, masterHealthCheck, lifecycleShouldAbandon = false;

        parameters.instanceId = instanceId;
        // get selfinstance
        this._selfInstance = this._selfInstance || await this.platform.describeInstance(parameters);
        // handle hb monitor
        // get self health check
        selfHealthCheck = selfHealthCheck || await this.platform.getInstanceHealthCheck({
            instanceId: this._selfInstance.instanceId
        }, interval);
        // if self is already out-of-sync, skip the monitoring logics
        if (selfHealthCheck && !selfHealthCheck.inSync) {
            return {};
        }
        // get master instance monitoring
        let masterInfo = await this.getMasterInfo();
        if (masterInfo) {
            masterHealthCheck = await this.platform.getInstanceHealthCheck({
                instanceId: masterInfo.instanceId
            }, interval);
        }
        // if this instance is the master, skip checking master election
        if (masterInfo && this._selfInstance.instanceId === masterInfo.instanceId) {
            // use master health check result as self health check result
            selfHealthCheck = masterHealthCheck;
        } else if (!(selfHealthCheck && selfHealthCheck.healthy)) {
            // if this instance is unhealth, skip master election check

        } else if (!(masterInfo && masterHealthCheck && masterHealthCheck.healthy)) {
            // if no master or master is unhealthy, try to run a master election or check if a
            // master election is running then wait for it to end
            // promiseEmitter to handle the master election process by periodically check:
            // 1. if there is a running election, then waits for its final
            // 2. if there isn't a running election, then runs an election and complete it
            let promiseEmitter = this.checkMasterElection.bind(this),
                // validator set a condition to determine if the fgt needs to keep waiting or not.
                validator = result => {
                    // if i am the new master, don't wait, continue to finalize the election.
                    // should return yes to end the waiting.
                    if (result &&
                        result.primaryPrivateIpAddress ===
                            this._selfInstance.primaryPrivateIpAddress) {
                        return true;
                    } else if (this._masterRecord && this._masterRecord.voteState === 'pending') {
                        // if i am not the new master, and the new master hasn't come up to
                        // finalize the election, I should keep on waiting.
                        // should return false to continue.
                        this._masterRecord = null; // clear the master record cache
                        return false;
                    } else if (this._masterRecord && this._masterRecord.voteState === 'done') {
                        // if i am not the new master, and the master election is final, then no
                        // need to wait.
                        // should return true to end the waiting.
                        return true;
                    }
                    // should return false to wait due to any other conditions
                    return false;
                },
                // counter to set a time based condition to end this waiting. If script execution
                // time is close to its timeout (6 seconds - abount 1 inteval + 1 second), ends the
                // waiting to allow for the rest of logic to run
                counter = currentCount => { // eslint-disable-line no-unused-vars
                    if (Date.now() < scriptExecutionExpireTime - 6000) {
                        return false;
                    }
                    logger.warn('script execution is about to expire');
                    return true;
                };

            try {
                masterInfo = await AutoScaleCore.waitFor(promiseEmitter, validator, 5000, counter);
                // after new master is elected, get the new master healthcheck
                // there are two possible results here:
                // 1. a new instance comes up and becomes the new master, master healthcheck won't
                // exist yet because this instance isn't added to monitor.
                //   1.1. in this case, the instance will be added to monitor.
                // 2. an existing slave instance becomes the new master, master healthcheck exists
                // because the instance in under monitoring.
                //   2.1. in this case, the instance will take actions based on its healthcheck
                //        result.
                masterHealthCheck = await this.platform.getInstanceHealthCheck({
                    instanceId: masterInfo.instanceId
                }, interval);
            } catch (error) {
                // if error occurs, check who is holding a master election, if it is this instance,
                // terminates this election. then continue
                this._masterRecord = this._masterRecord || await this.platform.getMasterRecord();
                if (this._masterRecord.instanceId === this._selfInstance.instanceId) {
                    await this.platform.removeMasterRecord();
                }
                await this.terminateInstanceInAutoScalingGroup(this._selfInstance);
                throw new Error(`Failed to determine the master instance within ${SCRIPT_TIMEOUT}` +
                    ' seconds. This instance is unable to bootstrap. Please report this to' +
                    ' administrators.');
            }
        }

        // check if myself is under health check monitoring
        // (master instance itself may have got its healthcheck result in some code blocks above)
        selfHealthCheck = selfHealthCheck || await this.platform.getInstanceHealthCheck({
            instanceId: this._selfInstance.instanceId
        }, interval);

        // if this instance is the master instance and the master record is still pending, finalize
        // the master election only in these two condition:
        // 1. this instance is under monitor and is healthy
        // 2. this instance is new and sending a respond with 'status: success'
        this._masterRecord = this._masterRecord || await this.platform.getMasterRecord();
        if (masterInfo && this._selfInstance.instanceId === masterInfo.instanceId &&
        this._masterRecord && this._masterRecord.voteState === 'pending') {
            if (selfHealthCheck && selfHealthCheck.healthy || !selfHealthCheck && statusSuccess) {
                // if election couldn't be finalized, remove the current election so someone else
                // could start another election
                if (!await this.platform.finalizeMasterElection()) {
                    await this.platform.removeMasterRecord();
                    this._masterRecord = null;
                    lifecycleShouldAbandon = true;
                }
            }
        }

        // the success status indicates that the instance acknowledges its config and starts to
        // send heart beat regularly
        // for those instance cannot send heart beat correctly, termination will be triggered by
        // default when their lifecycle action expired.
        // complete its lifecycle action in response to its call with 'status: success'
        if (statusSuccess) {
            await this.completeGetConfigLifecycleAction(this._selfInstance.instanceId,
                    statusSuccess && !lifecycleShouldAbandon);
        }

        // if no self healthcheck record found, this instance not under monitor. should make sure
        // its all lifecycle actions are complete before starting to monitor it.
        // for instance not yet in monitor and there's a master instance (regarless its health
        // status), add this instance to monitor
        if (!selfHealthCheck && masterInfo) {
            await this.addInstanceToMonitor(this._selfInstance,
                Date.now() + interval * 1000, masterInfo.primaryPrivateIpAddress);
            logger.info(`instance (id:${this._selfInstance.instanceId}, ` +
                `ip: ${this._selfInstance.primaryPrivateIpAddress}) is added to monitor.`);
            // if this newly come-up instance is the new master, save its instance id as the
            // default password into settings because all other instance will sync password from
            // the master there's a case if users never changed the master's password, when the
            // master was torn-down, there will be no way to retrieve this original password.
            // so in this case, should keep track of the update of default password.
            if (this._selfInstance.instanceId === masterInfo.instanceId) {
                await this.platform.setSettingItem('fortigate-default-password', {
                    value: this._selfInstance.instanceId,
                    description: 'default password comes from the new elected master.'
                });
            }
            return '';
        } else if (selfHealthCheck && selfHealthCheck.healthy && masterInfo) {
            // for those already in monitor, if there's a healthy master instance, keep track of
            // the master ip and notify the instanc with any change of the master ip.
            // if no master present (due to errors in master election), keep what ever master ip
            // it has, keep it in-sync without any notification for change in master ip.
            let masterIp = masterInfo && masterHealthCheck && masterHealthCheck.healthy ?
                masterInfo.primaryPrivateIpAddress : selfHealthCheck.masterIp;
            await this.platform.updateInstanceHealthCheck(selfHealthCheck, interval, masterIp,
                Date.now());
            logger.info(`instance (id:${this._selfInstance.instanceId}, ` +
            `ip: ${this._selfInstance.primaryPrivateIpAddress}) health check ` +
            `(${selfHealthCheck.healthy ? 'healthy' : 'unhealthy'}, ` +
            `heartBeatLossCount: ${selfHealthCheck.heartBeatLossCount}, ` +
            `nextHeartBeatTime: ${selfHealthCheck.nextHeartBeatTime}` +
            `syncState: ${selfHealthCheck.syncState}).`);
            return selfHealthCheck.masterIp !== masterIp ? {
                'master-ip': masterInfo.primaryPrivateIpAddress
            } : '';
        } else {
            // for unhealthy instances
            // if it is previously on 'in-sync' state, mark it as 'out-of-sync' so script will stop
            // keeping it in sync and stop doing any other logics for it any longer.
            if (selfHealthCheck.inSync) {
                // change its sync state to 'out of sync' by updating it state one last time
                await this.platform.updateInstanceHealthCheck(selfHealthCheck, interval,
                    masterInfo ? masterInfo.primaryPrivateIpAddress : null, Date.now(), true);
                // terminate it from auto-scaling group
                await this.terminateInstanceInAutoScalingGroup(this._selfInstance);
            }
            // for unhealthy instances, keep responding with action 'shutdown'
            return {
                action: 'shutdown'
            };
        }
    }

    async getMasterConfig(callbackUrl) {
        // no dollar sign in place holders
        return await this._baseConfig.replace(/\{CALLBACK_URL}/, callbackUrl);
    }

    async getSlaveConfig(masterIp, callbackUrl) {
        const
            autoScaleSectionMatch = AUTOSCALE_SECTION_EXPR.exec(this._baseConfig),
            autoScaleSection = autoScaleSectionMatch && autoScaleSectionMatch[1],
            matches = [
                /set\s+sync-interface\s+(.+)/.exec(autoScaleSection),
                /set\s+psksecret\s+(.+)/.exec(autoScaleSection),
                /set\s+admin-sport\s+(.+)/.exec(autoScaleSection)
            ];
        const [syncInterface, pskSecret, adminPort] = matches.map(m => m && m[1]),
            apiEndpoint = callbackUrl,
            config = `
                        config system auto-scale
                            set status enable
                            set sync-interface ${syncInterface ? syncInterface : 'port1'}
                            set role slave
                            set master-ip ${masterIp}
                            set callback-url ${apiEndpoint}
                            set psksecret ${pskSecret}
                        end
                        config system dns
                            unset primary
                            unset secondary
                        end
                        config system global
                            set admin-console-timeout 300
                        end
                        config system global
                            set admin-sport ${adminPort ? adminPort : '8443'}
                        end
                    `;
        let errorMessage;
        if (!apiEndpoint) {
            errorMessage = 'Api endpoint is missing';
        }
        if (!masterIp) {
            errorMessage = 'Master ip is missing';
        }
        if (!pskSecret) {
            errorMessage = 'psksecret is missing';
        }
        if (!pskSecret || !apiEndpoint || !masterIp) {
            throw new Error(`Base config is invalid (${errorMessage}): ${
                JSON.stringify({
                    syncInterface,
                    apiEndpoint,
                    masterIp,
                    pskSecret: pskSecret && typeof pskSecret
                })}`);
        }
        await config.replace(SET_SECRET_EXPR, '$1 *');
        return config;
    }

    async checkMasterElection() {
        let masterInfo,
            masterHealthCheck,
            needElection = false,
            purgeMaster = false,
            electionLock = false,
            electionComplete = false;

        // is there a master election done?
        // check the master record and its voteState
        //
        this._masterRecord = this._masterRecord || await this.platform.getMasterRecord();
        // if there's a complete election, get master health check
        if (this._masterRecord && this._masterRecord.voteState === 'done') {
        // get the current master info
            masterInfo = await this.getMasterInfo();
            // get current master heart beat record
            if (masterInfo) {
                masterHealthCheck =
                await this.platform.getInstanceHealthCheck({
                    instanceId: masterInfo.instanceId
                });
            }
            // if master is unhealthy, we need a new election
            if (!masterHealthCheck || !masterHealthCheck.healthy || !masterHealthCheck.inSync) {
                purgeMaster = needElection = true;
            } else {
                purgeMaster = needElection = false;
            }
        } else if (this._masterRecord && this._masterRecord.voteState === 'pending') {
            // if there's a pending master election, and if this election is incomplete by
            // the end-time, purge this election and starta new master election. otherwise, wait
            // until it's finished
            needElection = purgeMaster = Date.now() > this._masterRecord.voteEndTime;
        } else {
            // if no master, try to hold a master election
            needElection = true;
            purgeMaster = false;
        }
        // if we need a new master, let's hold a master election!
        if (needElection) {
        // can I run the election? (diagram: anyone's holding master election?)
        // try to put myself as the master candidate
            electionLock = await this.putMasterElectionVote(this._selfInstance, purgeMaster);
            if (electionLock) {
            // yes, you run it!
                this.logger.info(`This instance (id: ${this._selfInstance.instanceId})` +
            ' is running an election.');
                try {
                // (diagram: elect new master from queue (existing instances))
                    electionComplete = await this.electMaster();
                    this.logger.info(`Election completed: ${electionComplete}`);
                    // (diagram: master exists?)
                    masterInfo = electionComplete && await this.getMasterInfo();
                } catch (error) {
                    this.logger.error('Something went wrong in the master election.');
                }
            }
        }
        return Promise.resolve(masterInfo);
    }

    /**
     * get the elected master instance info from the platform
     */
    async getMasterInfo() {
        this.logger.info('calling getMasterInfo');
        let instanceId;
        try {
            this._masterRecord = this._masterRecord || await this.platform.getMasterRecord();
            instanceId = this._masterRecord && this._masterRecord.instanceId;
        } catch (ex) {
            this.logger.error(ex);
        }
        return this._masterRecord && await this.platform.describeInstance(
            { instanceId: instanceId });
    }

    /**
     * Submit an election vote for this ip address to become the master.
     * @param {Object} candidateInstance instance of the FortiGate which wants to become the master
     * @param {Object} purgeMasterRecord master record of the old master, if it's dead.
     */
    async putMasterElectionVote(candidateInstance, purgeMasterRecord = null) {
        try {
            this.logger.log('masterElectionVote, purge master?', JSON.stringify(purgeMasterRecord));
            if (purgeMasterRecord) {
                try {
                    const purged = await this.purgeMaster();
                    this.logger.log('purged: ', purged);
                } catch (error) {
                    this.logger.log('no master purge');
                }
            } else {
                this.logger.log('no master purge');
            }
            return await this.platform.putMasterRecord(candidateInstance, 'pending', 'new');
        } catch (ex) {
            this.logger.warn('exception while putMasterElectionVote',
                JSON.stringify(candidateInstance), JSON.stringify(purgeMasterRecord), ex.stack);
            return false;
        }
    }

    /**
     * Do the master election
     * @returns {boolean} if election has been successfully completed
     */
    async electMaster() {
        // return the current master record
        return !!await this.platform.getMasterRecord();
    }

    async completeMasterElection(ip) {
        await this.throwNotImplementedException();
        return ip;
    }

    async completeMasterInstance(instanceId) {
        await this.throwNotImplementedException();
        return instanceId;
    }

    responseToHeartBeat(masterIp) {
        let response = {};
        if (masterIp) {
            response['master-ip'] = masterIp;
        }
        return JSON.stringify(response);
    }

    async getFazIp() {
        await this.throwNotImplementedException();
        return null;
    }

    async handleNicAttachment(event) {
        await this.throwNotImplementedException();
        return null || event;
    }

    async handleNicDetachment(event) {
        await this.throwNotImplementedException();
        return null || event;
    }

    async loadSubnetPairs() {
        return await this.platform.getSettingItem('subnets-pairs');
    }

    async saveSubnetPairs(subnetPairs) {
        return await this.platform.setSettingItem('subnets-pairs', subnetPairs);
    }

    async loadSettings() {
        return await this.platform.getSettingItem('auto-scaling-group');
    }

    async saveSettings(desiredCapacity, minSize, maxSize) {
        let settingValues = {
            desiredCapacity: desiredCapacity,
            minSize: minSize,
            maxSize: maxSize
        };
        return await this.platform.setSettingItem('auto-scaling-group', settingValues);
    }

    async updateCapacity(desiredCapacity, minSize, maxSize) {
        await this.throwNotImplementedException();
        return null || desiredCapacity && minSize && maxSize;
    }

    async checkAutoScalingGroupState() {
        await this.throwNotImplementedException();
    }

    async resetMasterElection() {
        await this.throwNotImplementedException();
    }

    async addInstanceToMonitor(instance, nextHeartBeatTime, masterIp) {
        return await this.throwNotImplementedException() ||
            instance && nextHeartBeatTime && masterIp;
    }

    async removeInstanceFromMonitor(instance) {
        return await this.throwNotImplementedException() || instance;
    }

    async purgeMaster() {
        return await this.throwNotImplementedException();
    }

    async deregisterMasterInstance(instance) {
        return await this.throwNotImplementedException() || instance;
    }

    async terminateInstanceInAutoScalingGroup(instance) {
        return await this.throwNotImplementedException() || instance;
    }
};
