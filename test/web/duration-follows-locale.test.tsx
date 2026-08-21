import { afterEach, expect, test } from "bun:test";
import { cleanup, render, valueOf } from "../support/render.tsx";
import { DurationAmount } from "../../web/src/features/knobs/editors.tsx";
import { i18n } from "../../web/src/i18n.ts";
import { messages } from "../../web/src/locales/ru.po";

/**
 * A duration field carries a translated unit, so what it shows depends on the
 * locale as well as on the number.
 *
 * The effect that re-derives the text was keyed on `ms` alone. Switching the
 * panel to Russian moved every label around this field and left the field itself
 * reading `20 min` — the raw dependency in scope rather than the resolved value.
 */

afterEach(() => {
  cleanup();
  i18n.activate("zh");
});

test("switching language rewrites the unit inside the field, not only its label", () => {
  i18n.load("ru", messages);
  i18n.activate("en");
  const { getByLabelText, rerender } = render(
    <DurationAmount ms={1_200_000} label="Turn timeout" onWrite={() => {}} />,
  );
  expect(valueOf(getByLabelText("Turn timeout"))).toBe("20 min");

  i18n.activate("ru");
  rerender(<DurationAmount ms={1_200_000} label="Таймаут хода" onWrite={() => {}} />);

  expect(valueOf(getByLabelText("Таймаут хода"))).toBe("20 мин");
});
