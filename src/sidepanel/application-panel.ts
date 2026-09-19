export function mountApplicationPanel(container: HTMLElement): void {
  const root = document.createElement("div");
  root.className = "p-4 flex flex-col gap-3 text-sm";
  root.append(Object.assign(document.createElement("h1"), {
    textContent: "Application — what is this site doing with me?",
    className: "text-neutral-100 font-medium",
  }));
  container.appendChild(root);
}
