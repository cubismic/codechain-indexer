import * as Sequelize from "sequelize";
import { AssetTransferInputAttribute } from "./assettransferinput";

export interface AssetTransferBurnInstance
    extends Sequelize.Instance<AssetTransferInputAttribute> {}

export default (
    sequelize: Sequelize.Sequelize,
    DataTypes: Sequelize.DataTypes
) => {
    const AssetTransferBurn = sequelize.define(
        "AssetTransferBurn",
        {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: DataTypes.BIGINT
            },
            transactionHash: {
                allowNull: false,
                type: DataTypes.STRING,
                onDelete: "CASCADE",
                validate: {
                    is: ["^[a-f0-9]{64}$"]
                },
                references: {
                    model: "Transactions",
                    key: "hash"
                }
            },
            prevOut: {
                allowNull: false,
                type: DataTypes.JSONB
            },
            index: {
                allowNull: false,
                type: DataTypes.INTEGER
            },
            owner: {
                type: DataTypes.STRING
            },
            assetType: {
                allowNull: false,
                type: DataTypes.STRING,
                validate: {
                    is: ["^[a-f0-9]{40}$"]
                }
            },
            shardId: {
                allowNull: false,
                type: DataTypes.INTEGER
            },
            timelock: {
                type: DataTypes.JSONB
            },
            lockScript: {
                allowNull: false,
                type: DataTypes.JSONB
            },
            unlockScript: {
                allowNull: false,
                type: DataTypes.JSONB
            },
            createdAt: {
                allowNull: false,
                type: DataTypes.DATE
            },
            updatedAt: {
                allowNull: false,
                type: DataTypes.DATE
            }
        },
        {}
    );
    AssetTransferBurn.associate = models => {
        AssetTransferBurn.belongsTo(models.AssetScheme, {
            foreignKey: "assetType",
            as: "assetScheme"
        });
        // associations can be defined here
    };
    return AssetTransferBurn;
};
