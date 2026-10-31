/*
 |--------------------------------------------------------------------------
 | brand
 |--------------------------------------------------------------------------
 | The name, logo, icon and welcome sounds the player site shows. The web
 | repo (src/lib/brand.ts, brandAssets.ts) reads them from the shared
 | database within seconds and draws every logo slot from them:
 |
 |   settings    { _id : 'brand', name, version }
 |   brand_files { _id : 'logo' | 'icon' | 'welcome' | 'welcome-<lang>',
 |                 content_type, data, size, filename, uploaded_at, uploaded_by, version }
 |
 | Every change raises `version`, which makes the site redraw. Files are
 | checked by their content, not their name.
 |
 */

import { DEFAULT_NAME, FILE_IDS, checkUpload } from './brandRules';
import { getDb } from './db';
import { Invalid } from './validate';

export { DEFAULT_NAME, WELCOME_LANGS, parseName } from './brandRules';

export type BrandFileInfo = { id : string; content_type : string; size : number; filename : string; uploaded_at : Date; uploaded_by : string };
export type Brand = { name : string; version : number; files : Record<string, BrandFileInfo> };

export async function getBrand (): Promise<Brand> {
	const db = await getDb();
	const [doc, files]: [any, any[]] = await Promise.all([
		db.shared.settings.findById('brand').lean(),
		db.shared.brandFiles.find({}, { data : 0 }).lean()
	]);
	return {
		name    : doc?.name || DEFAULT_NAME,
		version : Number(doc?.version) || 0,
		files   : Object.fromEntries(files.map(f => [f._id, { id : f._id, content_type : f.content_type, size : f.size, filename : f.filename, uploaded_at : f.uploaded_at, uploaded_by : f.uploaded_by }]))
	};
}

/** raises the version (the player site redraws); returns it */
async function bump (set: Record<string, unknown> = {}): Promise<number> {
	const db = await getDb();
	const doc: any = await db.shared.settings.findOneAndUpdate({ _id : 'brand' }, { $inc : { version : 1 }, $set : set }, { upsert : true, new : true }).lean();
	return doc.version;
}

export const setName = async (name: string) => { await bump({ name }); };

export async function saveFile (id: string, data: Buffer, filename: string, admin: string): Promise<void> {
	const type = checkUpload(id, data);
	const db = await getDb();
	await db.shared.brandFiles.updateOne({ _id : id }, { $set : {
		content_type : type, data, size : data.length, filename : filename.slice(0, 120), uploaded_at : new Date(), uploaded_by : admin
	} }, { upsert : true });
	await bump();
}

export async function removeFile (id: string): Promise<void> {
	if (!FILE_IDS.includes(id)) throw new Invalid('Unknown file');
	const db = await getDb();
	await db.shared.brandFiles.deleteOne({ _id : id });
	await bump();
}

export async function fileData (id: string): Promise<{ data : Buffer; type : string } | null> {
	if (!FILE_IDS.includes(id)) return null;
	const db = await getDb();
	const doc: any = await db.shared.brandFiles.findById(id).lean();
	return doc ? { data : Buffer.from(doc.data.buffer ?? doc.data), type : doc.content_type } : null;
}
