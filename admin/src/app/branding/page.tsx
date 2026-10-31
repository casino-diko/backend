import { BrandNameForm, BrandUploadForm } from '../forms';
import { brandRemoveAction } from '@/lib/actions';
import { WELCOME_LANGS, getBrand, type BrandFileInfo } from '@/lib/brand';
import { config } from '@/lib/config';
import { dateTime } from '@/lib/format';
import { requireAdmin } from '@/lib/session';

const IMAGES = 'image/png,image/jpeg,image/webp,image/svg+xml';
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024)).toLocaleString('en-US')} KB`;

function Uploaded ({ file }: { file : BrandFileInfo }) {
	return <span className="muted">{file.filename} · {kb(file.size)} · {dateTime(file.uploaded_at)} by {file.uploaded_by}</span>;
}

function Remove ({ id }: { id : string }) {
	return (
		<form action={brandRemoveAction} style={{ display : 'inline' }}>
			<input type="hidden" name="id" value={id} />
			<button type="submit" className="link">Remove</button>
		</form>
	);
}

export default async function BrandingPage () {
	await requireAdmin();
	const brand = await getBrand();
	const v = brand.version;
	const site = config.playerSite;
	const logo = brand.files.logo;
	const icon = brand.files.icon;

	return (
		<>
			<h1>Branding</h1>
			<div className="panel">
				<p>The player site shows this name, logo, icon and welcome sound everywhere the former brand was: in the texts, the logos of the lobby and the games, the browser and home-screen icons. Changes show within a few seconds.</p>
				<BrandNameForm name={brand.name} />
			</div>

			<div className="grid">
				<div className="panel">
					<h2>Logo</h2>
					<p className="muted">Wide logos: lobby header, game screens, prompts, maintenance page. Fitted into each place keeping its proportions; a transparent PNG or an SVG works best.</p>
					{logo
						? <div className="brand-preview checker"><img src={`/branding/file/logo?v=${v}`} alt="Uploaded logo" /></div>
						: <p className="note">No logo: the site writes the name in bold letters.</p>}
					{logo && <p><Uploaded file={logo} /> · <Remove id="logo" /></p>}
					<BrandUploadForm id="logo" accept={IMAGES} label={logo ? 'Replace the logo' : 'Upload a logo'} />
				</div>
				<div className="panel">
					<h2>Icon</h2>
					<p className="muted">Square places: lobby corner on phones, browser tab, home-screen app. A square image, at least 512 × 512.</p>
					{icon
						? <div className="brand-preview checker square"><img src={`/branding/file/icon?v=${v}`} alt="Uploaded icon" /></div>
						: <p className="note">No icon: the site uses the name&apos;s first letter.</p>}
					{icon && <p><Uploaded file={icon} /> · <Remove id="icon" /></p>}
					<BrandUploadForm id="icon" accept={IMAGES} label={icon ? 'Replace the icon' : 'Upload an icon'} />
				</div>
			</div>

			<div className="panel">
				<h2>Welcome sound</h2>
				<p className="muted">Played when a player opens the lobby. A language without its own file plays the one for all languages; with none at all, the lobby stays silent (the former sound named the former brand). MP3, at most 5 MB.</p>
				<table>
					<thead><tr><th>Language</th><th>Sound</th><th>Upload</th></tr></thead>
					<tbody>
						{[{ code : '', label : 'All languages' }, ...WELCOME_LANGS].map(l => {
							const id = l.code ? `welcome-${l.code}` : 'welcome';
							const file = brand.files[id];
							return (
								<tr key={id}>
									<td>{l.label}</td>
									<td>
										{file
											? <><audio controls preload="none" src={`/branding/file/${id}?v=${v}`} /><br /><Uploaded file={file} /> · <Remove id={id} /></>
											: <span className="muted">{l.code ? (brand.files.welcome ? 'plays the one for all languages' : 'silent') : 'none'}</span>}
									</td>
									<td><BrandUploadForm id={id} accept="audio/mpeg,.mp3" label="" /></td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			<div className="panel">
				<h2>On the player site</h2>
				<p className="muted">As players see it now, from <code>{site}</code>.</p>
				<div className="row" style={{ alignItems : 'center', gap : 24 }}>
					<div className="brand-preview dark"><img src={`${site}/lobby/img/nihtan_logo.png?v=${v}`} alt="Lobby logo" /></div>
					<div className="brand-preview dark"><img src={`${site}/poker/img/confirmation/nihtan-yellow_logo.png?v=${v}`} alt="Prompt logo" /></div>
					<div className="brand-preview square"><img src={`${site}/shared/app/icon-192.png?v=${v}`} alt="Home-screen icon" /></div>
				</div>
			</div>
		</>
	);
}
