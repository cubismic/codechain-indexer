import { SDK } from "codechain-sdk";
import { Block, H256, U64 } from "codechain-sdk/lib/core/classes";
import * as _ from "lodash";
import * as Sequelize from "sequelize";
import * as Exception from "../../exception";
import { BlockInstance } from "../block";
import models from "../index";
import * as TxModel from "./transaction";
import { strip0xPrefix } from "./utils/format";

export async function createBlock(
    block: Block,
    sdk: SDK,
    miningReward: U64,
    errorHints: { [transactionIndex: number]: string }
): Promise<BlockInstance> {
    let blockInstance: BlockInstance;
    try {
        blockInstance = await models.Block.create({
            parentHash: strip0xPrefix(block.parentHash.value),
            timestamp: block.timestamp,
            number: block.number,
            author: block.author.value,
            extraData: Buffer.from(block.extraData),
            transactionsRoot: strip0xPrefix(block.transactionsRoot.value),
            stateRoot: strip0xPrefix(block.stateRoot.value),
            resultsRoot: strip0xPrefix(block.resultsRoot.value),
            score: block.score.value.toString(10),
            seal: block.seal.map(s => Buffer.from(s)),
            hash: strip0xPrefix(block.hash.value),
            miningReward: miningReward.value.toString(10)
        });

        // FIXME: Currently, Sequelize doesn't support a bulkUpsert() for Postgres.
        await TxModel.removePendings(block.transactions.map(t => t.hash()));
        await TxModel.createTransactions(
            block.transactions,
            false,
            block.timestamp,
            errorHints
        );

        for (const tx of block.transactions) {
            if (tx.result) {
                await TxModel.applyTransaction(tx, sdk, block.number);
            }
        }
    } catch (err) {
        if (err instanceof Sequelize.UniqueConstraintError) {
            const duplicateFields = (err as any).fields;
            if (_.has(duplicateFields, "hash")) {
                throw Exception.AlreadyExist();
            }
        }
        console.error(err);
        throw Exception.DBError();
    }
    return blockInstance;
}

const includeArray = [
    {
        as: "transactions",
        model: models.Transaction,
        include: [
            {
                as: "mintAsset",
                model: models.MintAsset
            },
            {
                as: "transferAsset",
                model: models.TransferAsset,
                include: [
                    {
                        as: "outputs",
                        model: models.AssetTransferOutput
                    },
                    {
                        as: "inputs",
                        model: models.AssetTransferInput
                    },
                    {
                        as: "burns",
                        model: models.AssetTransferBurn
                    },
                    {
                        as: "orders",
                        model: models.OrderOnTransfer
                    }
                ]
            },
            {
                as: "composeAsset",
                model: models.ComposeAsset,
                include: [
                    {
                        as: "inputs",
                        model: models.AssetTransferInput
                    }
                ]
            },
            {
                as: "decomposeAsset",
                model: models.DecomposeAsset,
                include: [
                    {
                        as: "outputs",
                        model: models.AssetTransferOutput
                    }
                ]
            },
            {
                as: "increaseAssetSupply",
                model: models.IncreaseAssetSupply
            },
            {
                as: "wrapCCC",
                model: models.WrapCCC
            },
            {
                as: "unwrapCCC",
                model: models.UnwrapCCC,
                include: [
                    {
                        as: "burn",
                        model: models.AssetTransferBurn
                    }
                ]
            },
            {
                as: "pay",
                model: models.Pay
            },
            {
                as: "setRegularKey",
                model: models.SetRegularKey
            },
            {
                as: "createShard",
                model: models.CreateShard
            },
            {
                as: "store",
                model: models.Store
            },
            {
                as: "remove",
                model: models.Remove
            },
            {
                as: "custom",
                model: models.Custom
            }
        ]
    }
];

export async function getByHash(hash: H256): Promise<BlockInstance | null> {
    try {
        return await models.Block.findOne({
            where: {
                hash: strip0xPrefix(hash.value)
            },
            order: transactionOrder,
            include: includeArray
        });
    } catch (err) {
        console.error(err);
        throw Exception.DBError();
    }
}

export async function deleteBlockByNumber(
    blockNumber: number
): Promise<number> {
    try {
        return await models.Block.destroy({
            where: { number: blockNumber }
        });
    } catch (err) {
        console.log(err);
        throw Exception.DBError();
    }
}

export async function getBlocks(params: {
    address?: string;
    page?: number | null;
    itemsPerPage?: number | null;
}) {
    const { page = 1, itemsPerPage = 15, address } = params;
    let query = {};
    if (address) {
        query = {
            author: address
        };
    }
    try {
        return await models.Block.findAll({
            order: [["number", "DESC"], ...transactionOrder],
            limit: itemsPerPage!,
            offset: (page! - 1) * itemsPerPage!,
            where: query,
            include: includeArray
        });
    } catch (err) {
        console.log(err);
        throw Exception.DBError();
    }
}

export async function getNumberOfBlocks(params: { address?: string }) {
    const { address } = params;
    let query = {};
    if (address) {
        query = {
            author: address
        };
    }
    try {
        return await models.Block.count({
            where: query
        });
    } catch (err) {
        console.log(err);
        throw Exception.DBError();
    }
}

export async function getLatestBlock(): Promise<BlockInstance | null> {
    try {
        return await models.Block.findOne({
            order: [["number", "DESC"], ...transactionOrder],
            include: includeArray
        });
    } catch (err) {
        console.log(err);
        throw Exception.DBError();
    }
}

export async function getByNumber(
    blockNumber: number
): Promise<BlockInstance | null> {
    try {
        return await models.Block.findOne({
            where: {
                number: blockNumber
            },
            order: transactionOrder,
            include: includeArray
        });
    } catch (err) {
        console.error(err);
        throw Exception.DBError();
    }
}

export async function getByTime(
    timestamp: number
): Promise<BlockInstance | null> {
    try {
        const block = await models.Block.findOne({
            where: {
                timestamp: {
                    [Sequelize.Op.lte]: timestamp
                }
            },
            order: [
                ["timestamp", "DESC"],
                ["number", "DESC"],
                ...transactionOrder
            ],
            // FIXME: Included transactions are not used anywhere. But query it for consistency with other functions.
            include: includeArray
        });

        if (block == null) {
            return null;
        }

        const nextBlock = await getByNumber(block.get("number") + 1);
        if (nextBlock == null || nextBlock.get("timestamp") <= timestamp) {
            // If the `block` is the latest block, the future block's timestamp also could be less than or equal to the timestamp.
            // To ensure the `block` is the nearest block, the `block` should have the next block whose timestamp is greater than the `timestamp`.
            return null;
        }
        return block;
    } catch (err) {
        console.error(err);
        throw Exception.DBError();
    }
}

const transactionOrder = [
    [
        { model: models.Transaction, as: "transactions" },
        "transactionIndex",
        "ASC"
    ],
    [
        { model: models.Transaction, as: "transactions" },
        { as: "transferAsset", model: models.TransferAsset },
        { as: "inputs", model: models.AssetTransferInput },
        "index",
        "ASC"
    ],
    [
        { model: models.Transaction, as: "transactions" },
        { as: "transferAsset", model: models.TransferAsset },
        { as: "outputs", model: models.AssetTransferOutput },
        "index",
        "ASC"
    ],
    [
        { model: models.Transaction, as: "transactions" },
        { as: "transferAsset", model: models.TransferAsset },
        { as: "burns", model: models.AssetTransferBurn },
        "index",
        "ASC"
    ],
    [
        { model: models.Transaction, as: "transactions" },
        { as: "transferAsset", model: models.TransferAsset },
        { as: "orders", model: models.OrderOnTransfer },
        "index",
        "ASC"
    ],
    [
        { model: models.Transaction, as: "transactions" },
        { as: "composeAsset", model: models.ComposeAsset },
        { as: "inputs", model: models.AssetTransferInput },
        "index",
        "ASC"
    ],
    [
        { model: models.Transaction, as: "transactions" },
        { as: "decomposeAsset", model: models.DecomposeAsset },
        { as: "outputs", model: models.AssetTransferOutput },
        "index",
        "ASC"
    ]
];
