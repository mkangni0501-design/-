/** @type {import('next').NextConfig} */
const nextConfig = {
  // 允许你隔壁电脑的 IP 以及 localhost 访问核心资源
  allowedDevOrigins: ['192.168.1.11', 'localhost:3000']
};

export default nextConfig;