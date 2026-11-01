/*
 |--------------------------------------------------------------------------
 | void plan
 |--------------------------------------------------------------------------
 | What voiding a resulted round moves for each bet. Pure, covered by
 | test/voidPlan.test.ts.
 |
 | Settlement credited total_win (stake included) and the stake was taken
 | when the bet was placed, so undoing the round changes the balance by
 | stake - total_win: a lost bet gets its stake back, a won one gives its
 | profit back. A balance may go below zero (decided: the reversal is never
 | cut short; the admin shows it).
 |
 */

export type PlanBet = { _id : number; user_id : number; total_bet? : unknown; total_win? : unknown; status? : string };
export type PlanUser = { _id : number; vendor_id : number; money? : unknown };
export type PlanVendor = { _id : number; integration_type? : string };

export type VoidRow = {
	betId    : number;
	userId   : number;
	vendorId : number;
	wallet   : 'transfer' | 'seamless';
	stake    : number;
	paid     : number;            // credited at settlement, stake included
	change   : number;            // stake - paid, what the void moves
	balance  : number | null;     // transfer wallets: the balance now
	after    : number | null;     // ... and after the void
};

export const round2 = (n: number) => Math.round(n * 100) / 100;

export class PlanError extends Error {}

export function planVoid (bets: PlanBet[], users: Map<number, PlanUser>, vendors: Map<number, PlanVendor>): VoidRow[] {
	const rows: VoidRow[] = [];
	for (const bet of bets) {
		if (bet.status === 'refunded' || bet.status === 'rolled_back') continue;
		const stake = round2(Number(bet.total_bet) || 0);
		const paid = round2(Number(bet.total_win) || 0);
		if (stake <= 0 && paid <= 0) continue;

		const user = users.get(bet.user_id);
		if (!user) throw new PlanError(`Player #${bet.user_id} of bet #${bet._id} not found`);
		const vendor = vendors.get(user.vendor_id);
		if (!vendor) throw new PlanError(`Vendor #${user.vendor_id} of player #${user._id} not found`);

		const transfer = vendor.integration_type !== 'seamless';
		const change = round2(stake - paid);
		const balance = transfer ? round2(Number(user.money) || 0) : null;
		rows.push({
			betId    : bet._id,
			userId   : user._id,
			vendorId : vendor._id,
			wallet   : transfer ? 'transfer' : 'seamless',
			stake, paid, change, balance,
			after    : balance === null ? null : round2(balance + change)
		});
	}
	return rows;
}

/** the void's effect on the house: + when players lose money back, - when they get stakes back */
export const houseChange = (rows: VoidRow[]) => round2(-rows.reduce((s, r) => s + r.change, 0));
