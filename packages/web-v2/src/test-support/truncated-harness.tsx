import { createRoot } from "react-dom/client";
import { Truncated } from "@/design/primitives/truncated";

const LONG = "Project: qa-project-available-for-testing-0xxxxxx";

createRoot(document.getElementById("root") as HTMLElement).render(
  <div className="space-y-4 p-4">
    <div id="cut" className="w-40">
      <Truncated text={LONG} />
    </div>
    <div id="fits" className="w-40">
      <Truncated text="short" />
    </div>
    <button id="after" type="button">
      after
    </button>
  </div>,
);

Promise.all([document.fonts.load('400 15px "Hanken Grotesk"'), new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))]).then(() => {
  (window as unknown as { ready: boolean }).ready = true;
});
