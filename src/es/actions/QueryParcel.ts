import { ParcelDoc } from "codechain-indexer-types/lib/types";
import { H256 } from "codechain-sdk/lib/core/classes";
import { Client, CountResponse, SearchResponse } from "elasticsearch";
import * as _ from "lodash";
import { ElasticSearchAgent } from "..";
import { BaseAction } from "./BaseAction";

export class QueryParcel implements BaseAction {
    public agent!: ElasticSearchAgent;
    public client!: Client;
    public async getParcel(hash: H256): Promise<ParcelDoc | null> {
        const response = await this.searchParcel({
            sort: [{ blockNumber: { order: "desc" } }, { parcelIndex: { order: "desc" } }],
            size: 1,
            query: {
                bool: {
                    must: [{ term: { isRetracted: false } }, { term: { hash: hash.value } }]
                }
            }
        });
        if (response.hits.total === 0) {
            return null;
        }
        return response.hits.hits[0]._source;
    }

    public async getParcels(
        params?: {
            lastBlockNumber?: number | null;
            lastParcelIndex?: number | null;
            itemsPerPage?: number | null;
            address?: string | null;
            onlyUnconfirmed?: boolean | null;
            currentBestBlockNumber?: number | null;
            confirmThreshold?: number | null;
        } | null
    ): Promise<ParcelDoc[]> {
        const query: any = [{ term: { isRetracted: false } }];
        const itemsPerPage = params && params.itemsPerPage != undefined ? params.itemsPerPage : 25;
        const lastBlockNumber =
            params && params.lastBlockNumber != undefined ? params.lastBlockNumber : Number.MAX_VALUE;
        const lastParcelIndex =
            params && params.lastParcelIndex != undefined ? params.lastParcelIndex : Number.MAX_VALUE;

        if (params && params.address) {
            const address = params.address;
            query.push({
                bool: {
                    should: [{ term: { signer: address } }, { term: { "action.receiver": address } }]
                }
            });
        }
        if (params && params.onlyUnconfirmed && params.currentBestBlockNumber && params.confirmThreshold) {
            query.push({
                range: {
                    "data.blockNumber": {
                        gte: params.currentBestBlockNumber - params.confirmThreshold
                    }
                }
            });
        }

        const response = await this.searchParcel({
            sort: [{ blockNumber: { order: "desc" } }, { parcelIndex: { order: "desc" } }],
            search_after: [lastBlockNumber, lastParcelIndex],
            size: itemsPerPage,
            query: {
                bool: {
                    must: query
                }
            }
        });
        return _.map(response.hits.hits, hit => hit._source);
    }

    public async getTotalParcelCount(): Promise<number> {
        const count = await this.countParcel({
            query: {
                term: { isRetracted: false }
            }
        });
        return count.count;
    }

    public async getParcelsByPlatformAddress(
        address: string,
        params?: {
            page?: number | null;
            itemsPerPage?: number | null;
        } | null
    ): Promise<ParcelDoc[]> {
        const page = params && params.page != undefined ? params.page : 1;
        const itemsPerPage = params && params.itemsPerPage != undefined ? params.itemsPerPage : 6;
        const response = await this.searchParcel({
            sort: [{ blockNumber: { order: "desc" } }, { parcelIndex: { order: "desc" } }],
            from: (page - 1) * itemsPerPage,
            size: itemsPerPage,
            query: {
                bool: {
                    must: [
                        { term: { isRetracted: false } },
                        {
                            bool: {
                                should: [{ term: { signer: address } }, { term: { "action.receiver": address } }]
                            }
                        }
                    ]
                }
            }
        });
        return _.map(response.hits.hits, hit => hit._source);
    }

    public async getTotalParcelCountByPlatformAddress(address: string): Promise<number> {
        const count = await this.countParcel({
            query: {
                bool: {
                    must: [
                        { term: { isRetracted: false } },
                        {
                            bool: {
                                should: [{ term: { signer: address } }, { term: { "action.receiver": address } }]
                            }
                        }
                    ]
                }
            }
        });
        return count.count;
    }

    public async searchParcel(body: any): Promise<SearchResponse<any>> {
        return this.client.search({
            index: "parcel",
            type: "_doc",
            body
        });
    }

    public async retractParcel(parcelHash: H256): Promise<void> {
        return this.updateParcel(parcelHash, { isRetracted: true });
    }

    public async indexParcel(parcelDoc: ParcelDoc): Promise<any> {
        return this.client.index({
            index: "parcel",
            type: "_doc",
            id: parcelDoc.hash,
            body: parcelDoc
        });
    }

    public async updateParcel(hash: H256, partial: any): Promise<any> {
        return this.client.update({
            index: "parcel",
            type: "_doc",
            id: hash.value,
            body: {
                doc: partial
            }
        });
    }

    public async countParcel(body: any): Promise<CountResponse> {
        return this.client.count({
            index: "parcel",
            type: "_doc",
            body
        });
    }
}
