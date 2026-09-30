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

/** Chart colours for the current colour scheme (SVG attributes can't read CSS variables). */
export function useChartTheme() {
  const query = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [dark, setDark] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [query]);
  return dark ? DARK : LIGHT;
}
