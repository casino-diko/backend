import type { Metadata } from 'next';
import Link from 'next/link';
import { logout } from '@/lib/actions';
import { getBrand } from '@/lib/brand';
import { currentAdmin } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = { title : 'Casino admin' };

export default async function RootLayout ({ children }: { children : React.ReactNode }) {
	const admin = await currentAdmin();
	const name = admin ? (await getBrand().catch(() => null))?.name ?? 'Casino' : 'Casino';

	return (
		<html lang="en">
			<body>
				{admin && (
					<header className="top">
						<strong className="brand">{name} admin</strong>
						<nav>
							<Link href="/">Players</Link>
							<Link href="/users/new">Add player</Link>
							<Link href="/transactions">Transactions</Link>
							<Link href="/vendors">Vendors</Link>
							<Link href="/branding">Branding</Link>
						</nav>
						<form action={logout} className="who">
							<span>{admin}</span>
							<button type="submit" className="link">Log out</button>
						</form>
					</header>
				)}
				<main>{children}</main>
			</body>
		</html>
	);
}
