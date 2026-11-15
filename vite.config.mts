import { defineConfig } from "vite";

// The frontend reads its contract addresses and chain from the backend (GET /api/config), so one
// build works against the local Hardhat chain and against Sepolia.
export default defineConfig({
  root: "frontend",
  server: {
    // The backend (npm run dev:backend) serves evidence, claim status and the deployment under /api.
    proxy: { "/api": process.env.BACKEND_URL ?? "http://localhost:3000" }
  },
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true
  }
});
