// Broad-buyer launch sniper for the Pump.fun Sharpe Sprint.
//
// The dev window taught me three things, and this bot is built on all of
// them. First, the opening spike is mostly gone before a buy can fill: the
// replay charges two slots of latency, so by the time an order lands the
// price is already past the launch print, and buying after the spike loses
// money at every entry point I measured. Second, the coins that do run are
// the ones lots of different wallets buy early: in the dev data the winners
// had a median of three to four distinct buyers in their first slots while
// the losers had two, and coins with seven or more early buyers won a third
// of the time. Third, a launch the creator funds heavily is a dump waiting
// to happen, and a creator who sells is the clearest exit signal there is.
//
// So the bot only buys a launch in its first ten slots, only when at least
// four distinct wallets have bought it so far, only when the creator's own
// opening buy is small (one SOL or less), only when the creator has not
// sold, and only while the price is still within thirty percent of the
// create print. It buys the most the one-percent reserve cap allows, up to
// five hundredths of a SOL, and it never holds more than five coins at once.
//
// Exits are deliberately boring: take fifteen percent, cut at minus eight,
// give up after a hundred and twenty slots, and leave the moment the
// creator sells. A coin that is sold out of stays out for two hundred slots
// so the bot does not chase the same fading launch twice.
//
// Nothing here reads the clock, the environment, or any randomness. Every
// decision comes from the batch the harness hands over, so the two graded
// executions agree byte for byte.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// How much to put into one launch, and the smallest buy worth sending.
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n;
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 200n;

// A fresh curve holds no real SOL, so wait until it has at least half a SOL
// of real reserve before the one-percent cap lets a meaningful buy through.
// Skip curves already past thirty SOL of real reserve: those are either
// finished running or too big for a launch snipe.
const MIN_REAL_SOL_LAMPORTS = LAMPORTS_PER_SOL / 2n;
const MAX_REAL_SOL_LAMPORTS = LAMPORTS_PER_SOL * 30n;

// The creator's own opening buy. Above one SOL the launch is usually the
// creator's own money pumping the print, and the coin fades after it.
const MAX_DEV_BUY_LAMPORTS = LAMPORTS_PER_SOL;

// Distinct wallets that must have bought the coin by decision time, and the
// most the bot will tolerate (a launch swarmed by dozens of wallets in its
// first slots is a bundle, not a crowd).
const MIN_BUYERS = 4;
const MAX_BUYERS = 20;

// How far the price may have run from the create print, in basis points.
const MAX_RUNUP_BPS = 3000;

// Only launches this young, in slots since their CreateEvent.
const MAX_AGE_SLOTS = 10;

// Exits, in basis points against the position's cost.
const TAKE_PROFIT_BPS = 1500;
const STOP_LOSS_BPS = 800;
const MAX_HOLD_SLOTS = 120;

// Slots to leave a coin alone after selling out of it.
const COOLDOWN_SLOTS = 200;

// Slippage is left wide open so an order is never refused for the price
// moving during the two-slot latency.
const MAX_SLIPPAGE_BPS = 10_000;

const BPS = 10_000n;

type Coin = {
  createSlot: number;
  creator: string | null;
  createPrice: number;
  devBuyLamports: number;
  buyers: Set<string>;
  devSold: boolean;
  doneUntilSlot: number;
};

type Held = {
  openedSlot: number;
};

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();

function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  if (curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

await runBot({
  onBatch(state, batch) {
    const slot = state.slot;
    const txFee = state.txFeeLamports();
    const caps = state.hello.caps;
    const orders: Array<BuyInput | SellInput> = [];

    // First pass over the batch: keep the launch profile of every coin up
    // to date. The buyer count covers every trade seen so far, not just the
    // create slot, because the bot decides up to ten slots after create and
    // should use all the tape it has.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            createSlot: e.slot,
            creator: e.creator,
            createPrice: Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves),
            devBuyLamports: 0,
            buyers: new Set(),
            devSold: false,
            doneUntilSlot: -1,
          });
        }
      } else if (e.event === 'TradeEvent') {
        let coin = coins.get(e.mint);
        if (coin === undefined) {
          const curve = state.curves.get(e.mint);
          coin = {
            createSlot: curve?.created_slot ?? slot,
            creator: null,
            createPrice: curve ? priceOf(curve) : 0,
            devBuyLamports: 0,
            buyers: new Set(),
            devSold: false,
            doneUntilSlot: -1,
          };
          coins.set(e.mint, coin);
        }
        if (e.is_buy) {
          coin.buyers.add(e.user);
          if (e.user === coin.creator) coin.devBuyLamports += Number(e.sol_amount);
        } else if (e.user === coin.creator) {
          coin.devSold = true;
        }
      } else if (e.event === 'CompleteEvent') {
        const coin = coins.get(e.mint);
        if (coin !== undefined) coin.doneUntilSlot = Number.MAX_SAFE_INTEGER;
        held.delete(e.mint);
      }
    }

    // Exits first, so a freed slot can be reused by an entry in the same batch.
    let free = state.freeCashLamports();
    for (const [mint, h] of [...held.entries()]) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        const buyPending = [...state.pending.values()].some(
          (po) => po.order.side === 'buy' && po.order.mint === mint,
        );
        if (buyPending) continue;
        held.delete(mint);
        continue;
      }
      if (curve === undefined) {
        held.delete(mint);
        continue;
      }
      const value =
        (pos.token_amount * curve.virtual_quote_reserves) /
        (curve.virtual_token_reserves + pos.token_amount);
      const cost = pos.cost_lamports;
      const age = slot - h.openedSlot;
      const coin = coins.get(mint);
      let exit = false;
      if (value >= (cost * (BPS + BigInt(TAKE_PROFIT_BPS))) / BPS) exit = true;
      else if (value <= (cost * (BPS - BigInt(STOP_LOSS_BPS))) / BPS) exit = true;
      else if (age >= MAX_HOLD_SLOTS) exit = true;
      else if (coin !== undefined && coin.devSold) exit = true;
      if (exit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        held.delete(mint);
        if (coin !== undefined) coin.doneUntilSlot = slot + COOLDOWN_SLOTS;
        free -= txFee;
      }
    }

    // Entries. Coins are taken in the order of the batch's events, and each
    // buy is capped by the one-percent reserve rule the harness enforces.
    let slots = caps.max_open_positions - state.committedPositionCount();
    if (slots > 0) {
      for (const e of batch.events) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (slots <= 0) break;
        if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
        const mint = e.mint;
        const coin = coins.get(mint);
        const curve = state.curves.get(mint);
        if (coin === undefined || curve === undefined || curve.complete) continue;
        if (curve.real_token_reserves === 0n) continue;
        if (held.has(mint)) continue;
        if (slot < coin.doneUntilSlot) continue;
        const age = slot - coin.createSlot;
        if (age < 0 || age > MAX_AGE_SLOTS) continue;
        const rq = curve.real_quote_reserves;
        if (rq < MIN_REAL_SOL_LAMPORTS || rq > MAX_REAL_SOL_LAMPORTS) continue;
        if (coin.devBuyLamports > Number(MAX_DEV_BUY_LAMPORTS)) continue;
        if (coin.buyers.size < MIN_BUYERS || coin.buyers.size > MAX_BUYERS) continue;
        if (coin.devSold) continue;
        const price = priceOf(curve);
        if (coin.createPrice > 0 && price > coin.createPrice * (1 + MAX_RUNUP_BPS / 10_000)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        let amount = STAKE_LAMPORTS;
        if (amount > cap) amount = cap;
        if (free < amount + txFee) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        free -= amount + txFee;
        slots -= 1;
        held.set(mint, { openedSlot: slot });
      }
    }

    return orders;
  },
});
