import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { captureToken } from "./api.ts";

captureToken();
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
