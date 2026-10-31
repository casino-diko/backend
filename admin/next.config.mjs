/** @type {import('next').NextConfig} */
const nextConfig = {
	output: 'standalone',
	poweredByHeader: false,
	// mongoose must not be bundled into the server build
	serverExternalPackages: ['mongoose'],
	// no site may frame the back-office (clickjacking)
	async headers() {
		return [{ source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }] }];
	}
};

export default nextConfig;
