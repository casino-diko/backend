import Link from 'next/link';
import { notFound } from 'next/navigation';
import { VoidForm } from '../../../forms';
import { GAME_LABELS, GAMES, type Game } from '@/lib/config';
import { dateTime, money, signed } from '@/lib/format';
import { getRound } from '@/lib/rounds';
import { cardsText, resultText, STATUS_LABELS } from '@/lib/roundText';
import { requireAdmin } from '@/lib/session';
import { houseChange } from '@/lib/voidPlan';

type Props = { params : Promise<{ game : string; id : string }> };

const BET_STATUS: Record<string, string> = { settled : 'settled', refunded : 'refunded', rolled_back : 'rolled back', open : 'open' };

const TOLD: Record<string, string> = {
	'road map' : 'told at once; their road maps dropped the mark',
	notice     : 'told at once; their road maps update on their next visit',
	'not sent' : 'not told at once (redis unreachable); they see it on their next visit'
};

export default async function RoundPage ({ params }: Props) {
	await requireAdmin();
	const { game, id } = await params;
	if (!GAMES.includes(game as Game) || !/^\d+$/.test(id)) notFound();
	const d = await getRound(game as Game, Number(id));
	if (!d) notFound();
	const { round } = d;
	const res = resultText(d.game, round.game_result);
	const cards = cardsText(d.game, round.game_info);
	const stake = d.bets.reduce((s, b) => s + b.stake, 0);
	const paid = d.bets.reduce((s, b) => s + (b.payout ?? 0), 0);
	const players = new Set(d.bets.map(b => b.user?._id)).size;
	// table names already carry the game ("Dragon-Tiger 1"); older ones may not
	const tableName = d.table.toLowerCase().includes(GAME_LABELS[d.game].toLowerCase()) ? d.table : `${GAME_LABELS[d.game]} ${d.table}`;

	return (
		<>
			<p><Link href={`/rounds?game=${d.game}&table=${round.table_id}`}>← {tableName} rounds</Link></p>
			<div className="spread">
				<h1>{tableName} · round {round.round_num}</h1>
				<span className={`pill st-${round.status}`}>{STATUS_LABELS[round.status] || round.status}</span>
			</div>

			<div className="grid">
				<div className="panel">
					<dl className="facts">
						<dt>Started (UTC)</dt><dd>{dateTime(round.created_at)}</dd>
						<dt>Dealer</dt><dd>{d.dealer || <span className="muted">unknown</span>}</dd>
						<dt>Result</dt><dd className={round.status === 'V' ? 'struck' : undefined}>{res || <span className="muted">none</span>}</dd>
						<dt>Cards</dt><dd>{cards || <span className="muted">none</span>}</dd>
						<dt>Bets</dt><dd>{money(stake)} from {players} player{players === 1 ? '' : 's'}</dd>
						{round.status === 'E' && <><dt>House net</dt><dd className={stake - paid < 0 ? 'neg' : undefined}>{signed(stake - paid)}</dd></>}
					</dl>
				</div>
				{round.closed && (
					<div className="panel">
						<h2>{round.closed.action === 'void' ? 'Voided' : 'Cancelled'}</h2>
						<dl className="facts">
							<dt>When (UTC)</dt><dd>{dateTime(round.closed.at)}</dd>
							<dt>Reason</dt><dd>{round.closed.reason}</dd>
							<dt>By</dt><dd>{round.closed.admin ? `admin ${round.closed.admin}` : `dealer #${round.closed.dealer_id ?? '?'}, supervisor #${round.closed.supervisor_id ?? '?'}`}</dd>
							{round.closed.mark && <><dt>Road map</dt><dd>{round.closed.mark === 'removed' ? 'mark removed' : 'no mark found for this round'}</dd></>}
							{round.closed.told && <><dt>Players</dt><dd>{TOLD[round.closed.told] || round.closed.told}</dd></>}
						</dl>
					</div>
				)}
			</div>

			<div className="panel scroll">
				<h2>Bets</h2>
				<table>
					<thead>
						<tr><th>Player</th><th>Wallet</th><th>Bet on</th><th className="num">Stake</th><th className="num">Winnings paid</th><th>Bet status</th></tr>
					</thead>
					<tbody>
						{d.bets.map(b => (
							<tr key={b._id}>
								<td>{b.user ? <Link href={`/users/${b.user._id}`}>{b.user.user_id} · {b.user.user_name}</Link> : <span className="muted">unknown player</span>}</td>
								<td className="muted">{b.wallet}</td>
								<td>{b.areas.length ? b.areas.map(a => `${a.area} ${money(a.stake)}`).join(', ') : <span className="muted">—</span>}</td>
								<td className="num">{money(b.stake)}</td>
								<td className="num">{b.payout === null ? <span className="muted">—</span> : money(b.payout)}</td>
								<td>{BET_STATUS[b.status] || b.status}{b.refunded ? <small className="muted"> · {money(b.refunded)} back</small> : null}</td>
							</tr>
						))}
						{!d.bets.length && <tr><td colSpan={6} className="muted">No bets in this round.</td></tr>}
					</tbody>
				</table>
			</div>

			{(d.tx.length > 0 || d.calls.length > 0) && (
				<div className="panel scroll">
					<h2>Money moved by the {round.status === 'V' ? 'void' : 'cancel'}</h2>
					<table>
						<thead><tr><th>Player</th><th>Wallet</th><th className="num">Change</th><th className="num">Balance after</th><th>State</th></tr></thead>
						<tbody>
							{d.tx.map(t => (
								<tr key={`tx${t._id}`}>
									<td><Link href={`/users/${t.user_id}`}>#{t.user_id}</Link></td>
									<td className="muted">transfer</td>
									<td className={`num ${t.amount < 0 ? 'neg' : 'pos'}`}>{signed(t.type === 'refund' ? Math.abs(t.amount) : t.amount)}</td>
									<td className={`num${t.balance_after < 0 ? ' neg' : ''}`}>{money(t.balance_after)}</td>
									<td>applied</td>
								</tr>
							))}
							{d.calls.map(c => (
								<tr key={`vc${c._id}`}>
									<td><Link href={`/users/${c.user_id}`}>#{c.user_id}</Link></td>
									<td className="muted">seamless</td>
									<td className="num">{signed(c.type === 'refund' ? Number(c.body?.amount) || 0 : Number(c.body?.change) || 0)}</td>
									<td className="num muted">at the vendor</td>
									<td>{c.done_at ? 'sent to the vendor' : <span className="badge">waiting for the vendor{c.attempts ? ` · ${c.attempts} tries` : ''}</span>}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{round.status === 'E' && (
				<div className="panel">
					<h2>Void this round</h2>
					<p className="muted">Every bet is undone: stakes go back and winnings are taken back, so each player ends as if the round never happened. The round&apos;s mark leaves the road map.</p>
					{d.planError
						? <p className="error">{d.planError}</p>
						: d.plan && d.plan.length > 0
							? (
								<div className="scroll">
									<table>
										<thead><tr><th>Player</th><th>Wallet</th><th className="num">Stake</th><th className="num">Paid</th><th className="num">Change</th><th className="num">Balance now</th><th className="num">After</th></tr></thead>
										<tbody>
											{d.plan.map(p => {
												const bet = d.bets.find(b => b._id === p.betId);
												return (
													<tr key={p.betId}>
														<td>{bet?.user ? `${bet.user.user_id} · ${bet.user.user_name}` : `#${p.userId}`}</td>
														<td className="muted">{p.wallet}</td>
														<td className="num">{money(p.stake)}</td>
														<td className="num">{money(p.paid)}</td>
														<td className={`num ${p.change < 0 ? 'neg' : p.change > 0 ? 'pos' : ''}`}>{signed(p.change)}</td>
														<td className="num">{p.balance === null ? <span className="muted">vendor</span> : money(p.balance)}</td>
														<td className={`num${p.after !== null && p.after < 0 ? ' neg' : ''}`}>
															{p.after === null ? <span className="muted">vendor</span> : money(p.after)}
															{p.after !== null && p.after < 0 && <small> below zero</small>}
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
									<p className="muted">House: {signed(houseChange(d.plan))}. Seamless players are reversed through their vendor&apos;s API.</p>
								</div>
							)
							: <p className="muted">No bets: voiding only takes the round off the road map.</p>}
					{!d.planError && <VoidForm game={d.game} roundId={round._id} />}
				</div>
			)}
		</>
	);
}
