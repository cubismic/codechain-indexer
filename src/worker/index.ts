import * as AsyncLock from "async-lock";
import { SDK } from "codechain-sdk";
import { Block, H256, U64 } from "codechain-sdk/lib/core/classes";
import * as _ from "lodash";
import { Job, scheduleJob } from "node-schedule";
import { InvalidBlockNumber } from "../exception";
import { BlockAttribute } from "../models/block";
import * as BlockModel from "../models/logic/block";
import * as TxModel from "../models/logic/transaction";
import * as AccountUtil from "./account";
import * as LogUtil from "./log";
import { strip0xPrefix } from "../models/logic/utils/format";

const ASYNC_LOCK_KEY = "worker";

export interface WorkerContext {
    sdk: SDK;
}

export interface WorkerConfig {
    watchSchedule: string;
}
export default class Worker {
    public context: WorkerContext;
    private watchJob!: Job;
    private config: WorkerConfig;
    private lock: AsyncLock;
    private lastIndexedPendingTime: number | null;
    private numlist: Array<number>;
    constructor(context: WorkerContext, config: WorkerConfig) {
        this.context = context;
        this.config = config;
        this.lock = new AsyncLock({ timeout: 30000, maxPending: 100 });
        this.lastIndexedPendingTime = null;
        this.numlist = new Array();
    }

    public destroy() {
        if (this.watchJob) {
            this.watchJob.cancel(false);
        }
    }

    public run = async () => {
        this.watchJob = scheduleJob(this.config.watchSchedule, async () => {
            try {
                if (this.lock.isBusy(ASYNC_LOCK_KEY) === false) {
                    await this.sync();
                }
            } catch (err) {
                const error = err as Error;
                if (error.message.search(/ECONNRESET|ECONNREFUSED/) >= 0) {
                    console.error("RPC Error");
                } else {
                    console.error(error);
                    this.watchJob.cancel(false);
                }
            }
        });
        this.watchJob.invoke();
    };

    public sync = async () => {
        const { sdk } = this.context;
        const chainBestBlockNumber = await sdk.rpc.chain.getBestBlockNumber();
        console.log("latest codechain block number : %d", chainBestBlockNumber);
        await this.lock
            .acquire(ASYNC_LOCK_KEY, () => {
                console.log("================ sync start ==================");
                return this.indexTransactionsAndSync(chainBestBlockNumber);
            })
            .then(() => {
                console.log("================ sync done ===================\n");
            })
            .catch(err => {
                console.error(
                    "================ sync failed ===================\n"
                );
                throw err;
            });
    };

    private indexTransactionsAndSync = async (
        chainBestBlockNumber: number
    ): Promise<void> => {
        const { sdk } = this.context;
        const latestIndexedBlockInst = await BlockModel.getLatestBlock();
        if (!latestIndexedBlockInst) {
            console.log("There is no synchronized block");
        } else {
            console.log(
                "latest indexed block number : %d",
                latestIndexedBlockInst.get({ plain: true }).number
            );
        }

        let lastIndexedBlockNumber = latestIndexedBlockInst
            ? latestIndexedBlockInst.get().number
            : -1;
        while (lastIndexedBlockNumber < chainBestBlockNumber) {
            const nextBlockNumber = lastIndexedBlockNumber + 1;
            const nextBlock = await sdk.rpc.chain.getBlock(nextBlockNumber);
            if (!nextBlock) {
                throw InvalidBlockNumber();
            }
            if (lastIndexedBlockNumber > 0) {
                const lastIndexedBlockInst = await BlockModel.getByNumber(
                    lastIndexedBlockNumber
                );
                const lastIndexedBlock = lastIndexedBlockInst!.get({
                    plain: true
                });
                if (nextBlock.parentHash.value !== lastIndexedBlock.hash) {
                    lastIndexedBlockNumber = await this.checkRetractAndReturnSyncNumber(
                        lastIndexedBlockNumber
                    );
                    continue;
                }
            }
            console.log("%d block is indexing...", nextBlockNumber);
            await this.indexNewBlock(nextBlock);
            console.log("%d block is synchronized", nextBlockNumber);
            lastIndexedBlockNumber = nextBlockNumber;
        }
        await this.indexPendingTransaction();
    };

    private checkRetractAndReturnSyncNumber = async (
        currentBlockNumber: number
    ) => {
        const { sdk } = this.context;
        while (currentBlockNumber > -1) {
            const currentIndexedBlock = (await BlockModel.getByNumber(
                currentBlockNumber
            ))!.get({ plain: true });
            const currentCodeChainBlock = await sdk.rpc.chain.getBlock(
                currentBlockNumber
            );
            if (!currentCodeChainBlock) {
                throw InvalidBlockNumber();
            }

            if (currentCodeChainBlock.hash.value === currentIndexedBlock.hash) {
                break;
            }

            console.log("%d block is retracting...", currentBlockNumber);
            await this.deleteBlock(currentIndexedBlock);
            console.log("%d block is retracted", currentBlockNumber);
            currentBlockNumber--;
        }
        return currentBlockNumber;
    };

    private indexNewBlock = async (block: Block) => {
        const { sdk } = this.context;

        let miningReward;
        if (block.number === 0) {
            miningReward = 0;
        } else {
            const miningRewardResponse = await sdk.rpc.sendRpcRequest(
                "chain_getMiningReward",
                [block.number]
            );
            if (miningRewardResponse === undefined) {
                throw InvalidBlockNumber();
            }
            miningReward = miningRewardResponse;
        }
        const errorHints: { [transactionIndex: number]: string } = {};
        await Promise.all(
            block.transactions.map(async tx => {
                if (tx.result === false) {
                    errorHints[
                        tx.transactionIndex!
                    ] = (await sdk.rpc.chain.getErrorHint(tx.hash()))!;
                }
            })
        );
        try {
            await BlockModel.createBlock(
                block,
                sdk,
                new U64(miningReward),
                errorHints
            );
        } catch (err) {
            await BlockModel.deleteBlockByNumber(block.number);
            throw err;
        }
        const blockInstance = await BlockModel.getByHash(block.hash);
        const blockAttribute = blockInstance!.get({ plain: true });
        await AccountUtil.updateAccount(
            blockAttribute,
            {
                checkingBlockNumber: block.number
            },
            this.context
        );
        await LogUtil.indexLog(blockAttribute, false);
    };

    private deleteBlock = async (block: BlockAttribute) => {
        await BlockModel.deleteBlockByNumber(block.number);
        await AccountUtil.updateAccount(
            block,
            {
                checkingBlockNumber: block.number - 1
            },
            this.context
        );
        await LogUtil.indexLog(block, true);
    };

    private indexPendingTransaction = async () => {
        // timestmap
        console.log("======== indexing pending transactions =======");
        console.log(
            (await this.context.sdk.rpc.chain.getPendingTransactions(
                this.lastIndexedPendingTime
            )).transactions.length
        );
        const {
            transactions,
            lastTimestamp
        } = await this.context.sdk.rpc.chain.getPendingTransactions();
        if (lastTimestamp != null) {
            if (this.numlist.indexOf(lastTimestamp) === -1) {
                this.numlist.push(lastTimestamp);
            }
        }
        console.log(`lastTimestamp == ${lastTimestamp}`);
        console.log(this.numlist);
        const indexedHashes = await TxModel.getAllPendingTransactionHashes();
        const indexed =  (await this.context.sdk.rpc.chain.getPendingTransactions()).transactions;
        // console.log(JSON.stringify(indexed[0]))
        // console.log(indexed);
        // console.log(indexedHashes);
        this.lastIndexedPendingTime = lastTimestamp;
        console.log(
            `Indexed: ${indexedHashes.length} / RPC: ${transactions.length}`
        );

        // await this.context.sdk.rpc.chain.getPendingTransactionsCount()

        // Remove dropped pending transactions //  hash, seq, signer
        const pendingHashes = transactions.map(p => p.hash().value);
        console.error(`transaction count ${transactions.length}`);
        console.error(`pendingHash count ${pendingHashes.length}`);
        console.error(`indexedHash count ${indexedHashes.length}`);
        const droppedPendingHashes = indexedHashes
            .filter(indexedHash => !pendingHashes.includes(indexedHash))
            .map(indexedHash => new H256(indexedHash));

         console.error("this is indexedHashes")
         console.error(indexedHashes)
         console.error("thisis pendingHashes")
         console.error(pendingHashes)
        console.error("this is original")
        console.error(
            droppedPendingHashes
        );
        /* if (droppedPendingHashes.length > 0) {
            await TxModel.removePendings(droppedPendingHashes);
        } */
        console.error("indexed")
        console.error(indexed.map(i => strip0xPrefix(i.hash().value)))
            // .hash().value)))
        console.error("test")
        console.error(indexed.map(i=> i.toJSON().seq))
        console.error(indexed.map(i=>i.getSignerAddress({networkId: i.toJSON().networkId}).getAccountId()))
         //    strip0xPrefix(i.getSignerAddress({networkId: i.toJSON().networkId}).value)))

        console.error("this is new")
        console.error((await TxModel.newRemovePendingstest(indexed)).map(i => i.get().hash));
        // await TxModel.newRemovePendings(indexed)
        // Index new pending transactions
        const newPendingTransactions = _.filter(
            transactions,
            pending => !_.includes(indexedHashes, pending.hash().value)
        );
        console.log(
            `newPendingTransaction count ${newPendingTransactions.length}`
        );

        await TxModel.createTransactions(newPendingTransactions, true);
    };
}
