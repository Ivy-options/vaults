import { expect } from "chai";
import { network } from "hardhat";
import { fixture } from "./helpers/setup.js";

const connection = await network.create();
const load = fixture(connection, () => connection.ethers.deployContract("IvyMathHarness"));

const UNIT = 10n ** 18n; // WETH unit
const USDC = 10n ** 6n;
const STRIKE = 3000n * USDC;

describe("IvyMath", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    m = await load();
  });

  it("call notional equals collateral", async () => {
    expect(await m.notionalOf(true, 10n * UNIT, UNIT, STRIKE)).to.equal(10n * UNIT);
  });

  it("put notional divides collateral by strike, rounding down", async () => {
    expect(await m.notionalOf(false, 30_000n * USDC, UNIT, STRIKE)).to.equal(10n * UNIT);
    expect(await m.notionalOf(false, 30_001n * USDC, UNIT, STRIKE)).to.equal(10_000_333_333_333_333_333n);
  });

  it("put notional is zero at a zero strike, while call notional ignores the strike", async () => {
    expect(await m.notionalOf(false, 30_000n * USDC, UNIT, 0n)).to.equal(0n);
    expect(await m.notionalOf(true, 10n * UNIT, UNIT, 0n)).to.equal(10n * UNIT);
  });

  it("premium total floors", async () => {
    expect(await m.premiumTotal(100n * USDC, 10n * UNIT, UNIT)).to.equal(1000n * USDC);
    expect(await m.premiumTotal(1n, 1n, UNIT)).to.equal(0n);
  });

  it("quote due rounds up, quote out rounds down", async () => {
    expect(await m.quoteDueCeil(1n, STRIKE, UNIT)).to.equal(1n);
    expect(await m.quoteOutFloor(1n, STRIKE, UNIT)).to.equal(0n);
    expect(await m.quoteDueCeil(4n * UNIT, STRIKE, UNIT)).to.equal(12_000n * USDC);
    expect(await m.quoteOutFloor(4n * UNIT, STRIKE, UNIT)).to.equal(12_000n * USDC);
  });

  it("call intrinsic is paid in underlying and is zero out of the money", async () => {
    expect(await m.callIntrinsic(4n * UNIT, STRIKE, 3300n * USDC)).to.equal(363_636_363_636_363_636n);
    expect(await m.callIntrinsic(4n * UNIT, STRIKE, STRIKE)).to.equal(0n);
    expect(await m.callIntrinsic(4n * UNIT, STRIKE, 2000n * USDC)).to.equal(0n);
  });

  it("put intrinsic is paid in quote and is zero out of the money", async () => {
    expect(await m.putIntrinsic(4n * UNIT, STRIKE, 2700n * USDC, UNIT)).to.equal(1200n * USDC);
    expect(await m.putIntrinsic(4n * UNIT, STRIKE, STRIKE, UNIT)).to.equal(0n);
    expect(await m.putIntrinsic(4n * UNIT, STRIKE, 4000n * USDC, UNIT)).to.equal(0n);
  });

  it("spot bound flips direction by kind", async () => {
    expect(await m.spotBound(true, STRIKE, 1000)).to.equal(2700n * USDC);
    expect(await m.spotBound(false, STRIKE, 1000)).to.equal(3300n * USDC);
    expect(await m.spotBound(true, STRIKE, 0)).to.equal(STRIKE);
  });
});
