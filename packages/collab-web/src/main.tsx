import { createRoot } from "react-dom/client";
import { App } from "./app";
import { readOmpWebConfig } from "./lib/use-local";
import { LocalApp } from "./local-app";
import "./styles/tokens.css";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

// Local full-control profile (served by the in-process web server) vs the
// relay guest SPA. Additive: without window.__OMP_WEB this is unchanged.
const localConfig = readOmpWebConfig();
createRoot(root).render(localConfig ? <LocalApp config={localConfig} /> : <App />);
