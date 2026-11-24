import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./main";
import "./styles.css";
import "./platform.css";
import "./widget.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
