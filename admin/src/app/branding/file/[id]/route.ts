import { fileData } from '@/lib/brand';
import { currentAdmin } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** an uploaded brand file, for the Branding page's previews */
export async function GET (_req: Request, ctx: { params : Promise<{ id : string }> }) {
	if (!(await currentAdmin())) return new Response('Forbidden', { status : 403 });
	const file = await fileData((await ctx.params).id);
	if (!file) return new Response('Not Found', { status : 404 });
	return new Response(new Uint8Array(file.data), {
		headers : {
			'content-type'            : file.type,
			'cache-control'           : 'no-store',
			// an uploaded svg is shown as an image only, never run as a page
			'content-security-policy' : "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'x-content-type-options'  : 'nosniff'
		}
	});
}
