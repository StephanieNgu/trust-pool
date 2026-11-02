import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./ErrorBoundary";
import "./styles.css";
import "./layout-fixes.css";
import "./capture.css";
import "./polish.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
