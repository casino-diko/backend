/** @type {import('next').NextConfig} */
const nextConfig = {
	output: 'standalone',
	poweredByHeader: false,
	// mongoose must not be bundled into the server build
	serverExternalPackages: ['mongoose']
};

export default nextConfig;
