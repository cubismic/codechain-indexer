
import models from "../src/models";
import * as Helper from "./helper";

beforeAll(async done => {
    await Helper.resetDb();
    // await Helper.worker.sync();

    done();
}, 300 * 1000);

afterAll(async done => {
    models.sequelize.close();
    done();
}, 300 * 1000);

test(
    "stopping",
    async done => {
        await Helper.sdk.rpc.devel.stopSealing();
        done();
    },
    300 * 1000
);

test(
    "going",
    async done => {
        await Helper.sdk.rpc.devel.startSealing();
        done();
    },
    300 * 1000
)
