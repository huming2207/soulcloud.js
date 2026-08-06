/**
 * i18n dictionary invariants across all five locales.
 */
import { describe, expect, test } from "bun:test";
import {
  dictionaries,
  EN_LONGER_KEYS,
  type DictKey,
  type Locale,
} from "./dictionary";

const LOCALES: Locale[] = ["zh", "en", "ru", "uk", "it"];

describe("dictionary completeness", () => {
  test("every locale covers every key (no missing translations)", () => {
    const zhKeys = Object.keys(dictionaries.zh);
    expect(zhKeys.length).toBeGreaterThan(250);
    for (const locale of LOCALES) {
      const keys = Object.keys(dictionaries[locale]);
      expect(keys.length).toBe(zhKeys.length);
      for (const k of zhKeys) {
        expect(dictionaries[locale][k as DictKey], `${locale}.${k}`).toBeDefined();
      }
    }
  });

  test("no value is empty or whitespace-only", () => {
    for (const locale of LOCALES) {
      for (const [k, v] of Object.entries(dictionaries[locale])) {
        expect(v.trim().length, `${locale}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  test("no leftover single-brace placeholders (i18next uses {{x}})", () => {
    for (const locale of LOCALES) {
      for (const [k, v] of Object.entries(dictionaries[locale])) {
        expect(v, `${locale}.${k}`).not.toMatch(/(?<!\{)\{[a-zA-Z_]\w*\}(?!\})/);
      }
    }
  });

  test("placeholder names are consistent across locales for the same key", () => {
    const placeholderRe = /\{\{(\w+)\}\}/g;
    for (const k of Object.keys(dictionaries.zh)) {
      const sets: Set<string>[] = LOCALES.map((loc) => {
        const s = new Set<string>();
        const v = dictionaries[loc][k as DictKey];
        for (const m of v.matchAll(placeholderRe)) s.add(m[1]!);
        return s;
      });
      const first = sets[0]!;
      for (let i = 1; i < sets.length; i++) {
        expect(
          [...first].sort().join(","),
          `${k} placeholders zh vs ${LOCALES[i]}`,
        ).toBe([...sets[i]!].sort().join(","));
      }
    }
  });
});

describe("translation quality hints", () => {
  test("english/cyrillic strings are mostly longer than chinese (layout risk)", () => {
    expect(EN_LONGER_KEYS.length).toBeGreaterThan(150);
    // spot check a few layout-critical keys
    for (const k of [
      "devices.new",
      "devices.empty",
      "fw.uploadRelease",
      "rollout.create.submit",
      "detail.issue",
      "deploy.doneBody",
    ]) {
      expect(
        dictionaries.en[k as DictKey].length,
        `${k} en longer than zh`,
      ).toBeGreaterThan(dictionaries.zh[k as DictKey].length);
    }
  });

  test("ru and uk are genuinely different languages (no copy-paste)", () => {
    // core UI words must differ between ru and uk
    const ru = dictionaries.ru;
    const uk = dictionaries.uk;
    expect(ru["nav.devices"]).not.toBe(uk["nav.devices"]);
    expect(ru["detail.credentials"]).not.toBe(uk["detail.credentials"]);
    expect(ru["auth.login"]).not.toBe(uk["auth.login"]);
    expect(ru["rollout.create.ratios"]).not.toBe(uk["rollout.create.ratios"]);
    // uk orthography: акаунт not аккаунт
    expect(uk["layout.account"]).toBe("Акаунт");
    expect(ru["layout.account"]).toBe("Аккаунт");
  });

  test("language names are correct in every locale", () => {
    for (const locale of LOCALES) {
      const d = dictionaries[locale];
      expect(d["layout.langZh"]).toBe("中文");
      expect(d["layout.langEn"]).toBe("English");
      expect(d["layout.langRu"]).toBe("Русский");
      expect(d["layout.langUk"]).toBe("Українська");
      expect(d["layout.langIt"]).toBe("Italiano");
    }
  });
});
