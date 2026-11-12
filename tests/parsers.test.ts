import { describe, expect, it } from "vitest";
import { calc, convert, timerPhrase } from "../src/command";
import { parseReminder } from "../src/reminders";
import { b64dec, b64enc, fixLayout, translit } from "../src/textTools";
import { lineAt, parseLrc } from "../src/lyrics";

describe("калькулятор", () => {
  it("считает с приоритетами и скобками", () => {
    expect(calc("2+2*3")).toBe(8);
    expect(calc("(2+2)*3")).toBe(12);
    expect(calc("2^10")).toBe(1024);
  });
  it("проценты, корни, запятая", () => {
    expect(calc("15%*200")).toBeCloseTo(30);
    expect(calc("sqrt(16)")).toBe(4);
    expect(calc("1,5*2")).toBe(3);
  });
  it("не принимает обычный текст и голые числа", () => {
    expect(calc("привет")).toBeNull();
    expect(calc("42")).toBeNull();
    expect(calc("2+")).toBeNull();
  });
});

describe("единицы", () => {
  it("длина, данные, температура", () => {
    expect(convert("5 км в милях")?.value).toMatch(/^3[.,]1/);
    expect(convert("2 гб в мб")?.value.replace(/\s/g, "")).toBe("2048");
    expect(convert("100 c to f")?.value).toBe("212");
  });
  it("разные величины не смешиваются", () => {
    expect(convert("5 кг в метрах")).toBeNull();
  });
});

describe("таймер", () => {
  it("минуты по умолчанию, секунды и часы", () => {
    expect(timerPhrase("таймер 10")).toBe(600_000);
    expect(timerPhrase("timer 90s")).toBe(90_000);
    expect(timerPhrase("таймер 1 ч")).toBe(3_600_000);
    expect(timerPhrase("таймер ноль")).toBeNull();
  });
});

describe("напоминания", () => {
  const now = new Date(2026, 10, 11, 12, 0); // среда, полдень
  it("через N минут", () => {
    const r = parseReminder("через 20 минут выключить плиту", now)!;
    expect(r.text).toBe("выключить плиту");
    expect(r.at - now.getTime()).toBe(20 * 60_000);
  });
  it("завтра в 9", () => {
    const r = parseReminder("позвонить маме завтра в 9", now)!;
    const at = new Date(r.at);
    expect(at.getDate()).toBe(12);
    expect(at.getHours()).toBe(9);
    expect(r.text).toBe("позвонить маме");
  });
  it("каждый день повторяется", () => {
    const r = parseReminder("таблетки каждый день в 23:00", now)!;
    expect(r.repeat?.days.length).toBe(7);
    expect(new Date(r.at).getHours()).toBe(23);
  });
});

describe("инструменты текста", () => {
  it("не та раскладка", () => {
    expect(fixLayout("ghbdtn")).toBe("привет");
  });
  it("транслит и base64 туда-обратно", () => {
    expect(translit("Клодик")).toBe("Klodik");
    expect(b64dec(b64enc("Остров ✓"))).toBe("Остров ✓");
  });
});

describe("текст песни", () => {
  const lines = parseLrc("[00:01.00] Раз\n[00:05.50] Два\n[01:00.00] Три");
  it("разбирает время", () => {
    expect(lines.map((l) => l.t)).toEqual([1000, 5500, 60000]);
  });
  it("находит строку, которая звучит", () => {
    expect(lineAt(lines, 500)).toBe(-1);
    expect(lineAt(lines, 6000)).toBe(1);
    expect(lineAt(lines, 99999)).toBe(2);
  });
});

import { pickModel } from "../src/ai";
describe("pickModel", () => {
  it("replaces a retired model with a live one of the same family", () => {
    const list = ["gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3.8-pro", "text-embedding-004", "gemini-3.9-flash-preview", "gemini-2.5-flash"];
    expect(pickModel(list, "gemini-2.5-flash")).toBe("gemini-3.8-flash");
    expect(pickModel(["a-embed"], "x")).toBeNull();
  });
});
