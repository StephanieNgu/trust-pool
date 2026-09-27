import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));
const localDeploymentPath = resolve(repositoryRoot, "deployments", "localhost.json");

function localDeploymentPlugin(): Plugin {
  return {
    name: "trust-pool-local-deployment",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== "/deployments/localhost.json") {
          next();
          return;
        }

        try {
          const deployment = await readFile(localDeploymentPath, "utf8");
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json");
          response.end(deployment);
        } catch {
          response.statusCode = 404;
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              error: "deployments/localhost.json was not found. Deploy the contracts locally first."
            })
          );
        }
      });
    },
    async generateBundle() {
      try {
        const deployment = await readFile(localDeploymentPath, "utf8");
        this.emitFile({
          type: "asset",
          fileName: "deployments/localhost.json",
          source: deployment
        });
      } catch {
        this.warn(
          "deployments/localhost.json was not found; the frontend build will not contain local contract addresses."
        );
      }
    }
  };
}

export default defineConfig({
  root: "frontend",
  plugins: [localDeploymentPlugin()],
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true
  }
});
