import { createChild, serverLogger } from '@neotracker/logger';
import {
  AddressToTransfer as AddressToTransferModel,
  Asset as AssetModel,
  AssetToTransaction as AssetToTransactionModel,
  Coin as CoinModel,
  Contract as ContractModel,
  NEP5_BLACKLIST_CONTRACT_TYPE,
  NEP5_CONTRACT_TYPE,
  QueryContext,
  Transfer as TransferModel,
} from '@neotracker/server-db';
import { AsyncIterableX } from 'ix/asynciterable/asynciterablex';
import Knex from 'knex';
import { concat, defer, Observable, Observer } from 'rxjs';
import { BlockUpdater, getCurrentHeight } from './db';
import { normalizeBlock } from './normalizeBlock';
import { repairNEP5 } from './repairNEP5';
import { Context } from './types';

const serverScrapeLogger = createChild(serverLogger, { component: 'scrape' });

class ExitError extends Error {}

const deleteNEP5 = async (db: Knex, makeQueryContext: () => QueryContext, contract: ContractModel): Promise<void> => {
  serverScrapeLogger.info({ title: 'neotracker_scrape_contract_delete_nep5' });
  const asset = await AssetModel.query(db)
    .context(makeQueryContext())
    .where('id', contract.id)
    .first();
  if (asset !== undefined) {
    await Promise.all([
      AddressToTransferModel.query(db)
        .context(makeQueryContext())
        .delete()
        .from(db.raw('address_to_transfer USING transfer'))
        .where(db.raw('address_to_transfer.id2 = transfer.id'))
        .where('transfer.asset_id', asset.id),
      CoinModel.query(db)
        .context(makeQueryContext())
        .delete()
        .where('asset_id', asset.id),
      AssetToTransactionModel.query(db)
        .context(makeQueryContext())
        .delete()
        .where('id1', asset.id),
      // Deleting AddressToTransaction is tricky because we probably want to
      // keep the ones where they transferred assets.
    ]);

    await TransferModel.query(db)
      .context(makeQueryContext())
      .delete()
      .where('asset_id', asset.id);
    await asset
      .$query(db)
      .context(makeQueryContext())
      .delete();
  }

  await contract
    .$query(db)
    .context(makeQueryContext())
    .patch({ type: NEP5_BLACKLIST_CONTRACT_TYPE });
};

const cleanBlacklist = async ({ context }: { readonly context: Context }): Promise<void> => {
  const contractModels = await ContractModel.query(context.db)
    .context(context.makeQueryContext())
    .where('type', NEP5_CONTRACT_TYPE)
    .whereIn('id', [...context.blacklistNEP5Hashes]);

  await Promise.all(
    contractModels.map(async (contractModel) => deleteNEP5(context.db, context.makeQueryContext, contractModel)),
  );
};

function doRun$({
  context: contextIn,
  blockUpdater,
}: {
  readonly context: Context;
  readonly blockUpdater: BlockUpdater;
}): Observable<void> {
  return new Observable((observer: Observer<void>) => {
    const signal = {
      running: true,
    };

    let context = contextIn;
    async function _run() {
      const startTime = Date.now();
      const height = await getCurrentHeight(context);
      const blocks = context.client.iterBlocks({
        indexStart: height + 1,
      });

      await AsyncIterableX.from(blocks).forEach(async (blockJSON) => {
        if (!signal.running) {
          throw new ExitError();
        }
        const block = normalizeBlock(blockJSON);

        serverScrapeLogger.info({ title: 'neotracker_persist_block' });
        context = await blockUpdater.save(context, block);
        const latency = startTime - block.time;

        if (block.index % context.repairNEP5BlockFrequency === 0 && latency <= context.repairNEP5LatencySeconds) {
          await repairNEP5(context);
        }
      });
    }

    _run()
      .then(() => observer.complete())
      .catch((error) => {
        if (!(error instanceof ExitError)) {
          observer.error(error);
        }
      });

    return {
      unsubscribe: () => {
        // tslint:disable-next-line no-object-mutation
        signal.running = false;
      },
    };
  });
}

// tslint:disable-next-line export-name
export const run$ = (context: Context, blockUpdater: BlockUpdater) =>
  concat(defer(async () => cleanBlacklist({ context })), doRun$({ context, blockUpdater }));
