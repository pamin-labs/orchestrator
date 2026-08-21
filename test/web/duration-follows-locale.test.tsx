import { afterEach, expect, test } from "bun:test";
import { cleanup, render, valueOf } from "../support/render.tsx";
import { DurationAmount } from "../../web/src/features/knobs/editors.tsx";
import { i18n } from "../../web/src/i18n.ts";
import { messages } from "../../locales/ru.po";

/**
 * A duration field carries a translated unit, so what it shows depends on the
 * locale as well as on the number.
 *
 * The number and the unit are two controls now — a box and a menu — and it is
 * the menu's trigger that has to follow the language. Before the split this was
 * one text box whose effect keyed on `ms`, so switching to Russian moved every
 * label around it and left the field itself reading `20 min`.
 */

afterEach(() => {
  cleanup();
  i18n.activate("zh");
});

test("switching language rewrites the unit beside the number, not only the label", () => {
  i18n.load("ru", messages);
  i18n.activate("en");
  const { getByLabelText, getByRole, rerender } = render(
    <DurationAmount ms={1_200_000} label="Turn timeout" onWrite={() => {}} />,
  );
  // The box holds the count alone; the unit is the menu's own label.
  expect(valueOf(getByLabelText("Turn timeout"))).toBe("20");
  expect(getByRole("button").textContent).toContain("min");

  i18n.activate("ru");
  rerender(<DurationAmount ms={1_200_000} label="Таймаут хода" onWrite={() => {}} />);

  expect(valueOf(getByLabelText("Таймаут хода"))).toBe("20");
  expect(getByRole("button").textContent).toContain("мин");
});
