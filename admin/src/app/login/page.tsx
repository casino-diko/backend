import { redirect } from 'next/navigation';
import { LoginForm } from '../forms';
import { config } from '@/lib/config';
import { currentAdmin } from '@/lib/session';

export default async function LoginPage () {
	const missing = [
		!config.admin.password && 'ADMIN_PASSWORD',
		config.session.secret.length < 32 && 'ADMIN_SESSION_SECRET (32+ characters)'
	].filter(Boolean);

	if (!missing.length && await currentAdmin()) redirect('/');
	return (
		<div className="panel login">
			<h1>Casino admin</h1>
			{missing.length
				? <p className="note">Not configured: set {missing.join(' and ')} and restart the service.</p>
				: <LoginForm />}
		</div>
	);
}
