import { startE2EServices } from "../scripts/e2e-server";

export default async function globalSetup() {
  return startE2EServices();
}
