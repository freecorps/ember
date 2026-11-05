import { EmberProvider } from "@freecorps/ember-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { client } from "./ember";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EmberProvider client={client}>
      <App />
    </EmberProvider>
  </StrictMode>,
);
