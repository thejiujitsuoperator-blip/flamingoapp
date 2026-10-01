import { useEffect, useState } from "react";

const LIGHT = {
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  surface: "#ffffff",
  grid: "#e7e6e2",
  axis: "#6b6a66",
  text: "#0b0b0b",
};
const DARK = {
  series: ["#3987e5", "#d95926", "#199e70", "#c98500"],
  surface: "#1f1f1d",
  grid: "#34332f",
  axis: "#a3a29a",
  text: "#ffffff",
};

/** An explicit data-theme on <html> wins; otherwise follow the OS setting. */
function isDark(): boolean {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Chart colours for the current colour scheme (SVG attributes can't read CSS variables). */
export function useChartTheme() {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const update = () => setDark(isDark());
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      query.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  return dark ? DARK : LIGHT;
}
