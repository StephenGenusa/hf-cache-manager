import { describe, expect, test } from "vitest";
import { KNOWLEDGE } from "../../src/shared/knowledge";
import { nameParts } from "../../src/shared/knowledge/name-parts";

const ids = (s: string) =>
  nameParts(s, KNOWLEDGE)
    .filter((p) => p.entryId)
    .map((p) => p.text);

test("round-trips", () =>
  expect(
    nameParts("unsloth/Qwen3.8-35B-A3B-it-MTP-GGUF", KNOWLEDGE)
      .map((p) => p.text)
      .join(""),
  ).toBe("unsloth/Qwen3.8-35B-A3B-it-MTP-GGUF"));
test("repo name", () =>
  expect(ids("unsloth/Qwen3.8-35B-A3B-it-MTP-GGUF")).toEqual([
    "Qwen3.8",
    "35B-A3B",
    "it",
    "MTP",
    "GGUF",
  ]));
test("recipe prefix then type", () =>
  expect(ids("UD-Q5_K_XL")).toEqual(["UD", "Q5_K_XL"]));
test("mradermacher i1", () =>
  expect(ids("Model.i1-IQ3_M.gguf")).toEqual(["i1", "IQ3_M"]));
test("shard suffix is one part", () =>
  expect(ids("Model-Q8_0-00001-of-00003.gguf")).toEqual([
    "Q8_0",
    "00001-of-00003",
  ]));
test("mmproj precision", () =>
  expect(ids("mmproj-BF16")).toEqual(["mmproj", "BF16"]));
test("unknown tag-looking part", () =>
  expect(
    nameParts("IQ3_M-XQ9", KNOWLEDGE).find((p) => p.text === "XQ9"),
  ).toMatchObject({
    entryId: null,
    looksLikeTag: true,
  }));
test("ordinary words are not tags", () =>
  expect(
    nameParts("MyFineTune-v2.gguf", KNOWLEDGE).some((p) => p.looksLikeTag),
  ).toBe(false));
test("quant types match case-insensitively", () =>
  expect(ids("model-q4_k_m.gguf")).toEqual(["q4_k_m"]));
test("short words stay case-sensitive", () =>
  expect(ids("It-IT-it")).toEqual(["it"]));
test("separators are their own parts", () => {
  const sep = nameParts("a/b.gguf", KNOWLEDGE).filter(
    (p) => p.text === "/" || p.text === ".gguf",
  );
  expect(sep).toEqual([
    { text: "/", entryId: null, looksLikeTag: false },
    { text: ".gguf", entryId: null, looksLikeTag: false },
  ]);
});

test("XL mix entry explains both meanings; UD-Q4_K_XL resolves to it and Q3_K_XL stays the recipe row", () => {
  const xl = KNOWLEDGE.entries.find((e) => e.id === "quant-type:xl-mix")!;
  expect(xl.text).toMatch(/Unsloth/);
  expect(xl.text).toMatch(/bartowski/);
  expect(xl.text).toMatch(/Q8_0/);
  expect(xl.section).toBe("recipes-that-make-normal-gguf-files");
  const idOf = (s: string, t: string) =>
    nameParts(s, KNOWLEDGE).find((p) => p.text === t)?.entryId;
  expect(idOf("model-Q3_K_XL", "Q3_K_XL")).toBe("recipe:_L");
  expect(idOf("UD-Q4_K_XL", "Q4_K_XL")).toBe("quant-type:xl-mix");
});
test("uppercase .GGUF is the extension separator", () => {
  const parts = nameParts("Model-Q8_0.GGUF", KNOWLEDGE);
  expect(parts[parts.length - 1]).toEqual({
    text: ".GGUF",
    entryId: null,
    looksLikeTag: false,
  });
  expect(parts.map((p) => p.text).join("")).toBe("Model-Q8_0.GGUF");
});
test("a span is at most 4 runs", () => {
  // 00001-of-00003 is 3 runs and matches; 5 runs of the same shape never join into one part.
  const parts = nameParts(
    "Q8_0-00001-of-00003-00002-of-00003",
    KNOWLEDGE,
  ).filter((p) => p.entryId);
  expect(parts.every((p) => p.text.split(/[-./ ]/).length <= 4)).toBe(true);
});

test("a span that crosses separators is one part only when its runs do not resolve alone", () => {
  const entry = (token: string) => ({
    id: `size:${token}`,
    kind: "size" as const,
    tokens: [token],
    patterns: [],
    title: token,
    text: token,
    section: "s",
  });
  const both = {
    checkedOn: "x",
    entries: [entry("A"), entry("B"), entry("A-B")],
  };
  expect(
    nameParts("A-B", both)
      .filter((p) => p.entryId)
      .map((p) => p.text),
  ).toEqual(["A", "B"]);
  const only = { checkedOn: "x", entries: [entry("A-B")] };
  expect(
    nameParts("A-B", only)
      .filter((p) => p.entryId)
      .map((p) => p.text),
  ).toEqual(["A-B"]);
});

// Direct, behaviour-level cases on small synthetic knowledge.
type Kind = "quant-type" | "recipe" | "size";
const mk = (
  id: string,
  kind: Kind,
  tokens: string[],
  patterns: string[] = [],
) =>
  ({ id, kind, tokens, patterns, title: id, text: id, section: "s" }) as never;
const know = (...entries: unknown[]) => ({ checkedOn: "x", entries }) as never;
const idOf = (text: string, k: never, part = text) =>
  nameParts(text, k).find((p) => p.text === part)?.entryId ?? null;

test("case folding applies to quant-type and recipe tokens longer than 3 only", () => {
  const k = know(
    mk("q", "quant-type", ["QUAN", "QNT"]),
    mk("r", "recipe", ["RECI", "RCP"]),
    mk("s", "size", ["SIZE"]),
  );
  expect(idOf("quan", k)).toBe("q");
  expect(idOf("reci", k)).toBe("r");
  expect(idOf("qnt", k)).toBeNull();
  expect(idOf("rcp", k)).toBeNull();
  expect(idOf("size", k)).toBeNull();
  expect(idOf("SIZE", k)).toBe("s");
  expect(idOf("QNT", k)).toBe("q");
});

test("the first entry wins for a repeated exact token and a repeated folded token", () => {
  const k = know(
    mk("a", "size", ["DUPE"]),
    mk("b", "size", ["DUPE"]),
    mk("c", "quant-type", ["FOLD"]),
    mk("d", "quant-type", ["fold"]),
  );
  expect(idOf("DUPE", k)).toBe("a");
  expect(idOf("Fold", k)).toBe("c");
  expect(idOf("fold", k)).toBe("d");
});

test("guide tokens lose every stray leading and trailing separator", () => {
  const k = know(
    mk("a", "size", ["--LEAD"]),
    mk("b", "size", ["TRAIL--"]),
    mk("c", "size", ["UD-"]),
    mk("d", "size", ["MTP/"]),
    mk("e", "size", [".mid."]),
  );
  expect(idOf("LEAD", k)).toBe("a");
  expect(idOf("TRAIL", k)).toBe("b");
  expect(idOf("UD", k)).toBe("c");
  expect(idOf("MTP", k)).toBe("d");
  expect(idOf("mid", k)).toBe("e");
  expect(idOf("Stryker was here!", k)).toBeNull();
});

test("tokens that contain a space or slash can never match", () => {
  const k = know(mk("a", "size", ["X Y"]), mk("b", "size", ["P/Q"]));
  expect(nameParts("X Y", k).some((p) => p.entryId)).toBe(false);
  expect(nameParts("P/Q", k).some((p) => p.entryId)).toBe(false);
});

test("patterns are anchored and case-insensitive", () => {
  const k = know(mk("p", "size", [], ["ab+"]));
  expect(idOf("ABB", k)).toBe("p");
  expect(idOf("xabb", k)).toBeNull();
  expect(idOf("abbx", k)).toBeNull();
  expect(idOf("zzz", k)).toBeNull();
});

test("separators never take an entry, even when a pattern would match them", () => {
  const k = know(mk("any", "size", [], ["."]));
  const sep = nameParts("a-b", k).find((p) => p.text === "-")!;
  expect(sep).toEqual({ text: "-", entryId: null, looksLikeTag: false });
});

test("no empty parts from leading, doubled or trailing separators", () => {
  const k = know();
  for (const s of ["--a", "a--b", "a-", "-", "a"]) {
    const parts = nameParts(s, k);
    expect(parts.every((p) => p.text !== "")).toBe(true);
    expect(parts.map((p) => p.text).join("")).toBe(s);
  }
  expect(nameParts("a--b", k).map((p) => p.text)).toEqual(["a", "-", "-", "b"]);
});

test("the finer split looks only at the runs inside the span", () => {
  const k = know(
    mk("a", "size", ["A"]),
    mk("b", "size", ["B"]),
    mk("ab", "size", ["A-B"]),
  );
  const parts = nameParts("A-B-ZZZ", k).filter((p) => p.entryId);
  expect(parts.map((p) => p.text)).toEqual(["A", "B"]);
});

test("a span of exactly four runs joins, five do not", () => {
  const k = know(
    mk("four", "size", ["a-b-c-d"]),
    mk("five", "size", ["a-b-c-d-e"]),
  );
  expect(idOf("a-b-c-d", k)).toBe("four");
  expect(idOf("a-b-c-d-e", k, "a-b-c-d-e")).toBeNull();
});

test("a matched span is never flagged as an unknown tag", () => {
  const parts = nameParts("Q8_0", KNOWLEDGE);
  expect(parts).toEqual([
    { text: "Q8_0", entryId: expect.any(String), looksLikeTag: false },
  ]);
});

test("looksLikeTag: upper-case letters or digit+underscore, up to 12 characters", () => {
  const k = know();
  const tag = (s: string) => nameParts(s, k)[0]!.looksLikeTag;
  expect(tag("ABCDEFGHIJKL")).toBe(true); // 12
  expect(tag("ABCDEFGHIJKLM")).toBe(false); // 13
  expect(tag("1_2_3_4_5_6_7")).toBe(false); // 13, digit and underscore
  expect(tag("XQ")).toBe(true);
  expect(tag("XQ9")).toBe(true);
  expect(tag("123")).toBe(false);
  expect(tag("abcDE")).toBe(false);
  expect(tag("a_b")).toBe(false);
  expect(tag("a1_b")).toBe(true);
  expect(tag("1_2")).toBe(true);
});

test("the index is built once per Knowledge object", () => {
  const entries = [mk("a", "size", ["AAA"])];
  const k = { checkedOn: "x", entries } as never;
  expect(idOf("AAA", k)).toBe("a");
  entries.push(mk("b", "size", ["BBB"]));
  expect(idOf("BBB", k)).toBeNull();
});

describe("W#A# quantization names", () => {
  const part = (name: string, text: string) =>
    nameParts(name, KNOWLEDGE).find((p) => p.text === text);

  test.each(["W6A8", "W4A8", "W8A8", "w6a8", "w4a8s", "MXFP6", "INT6"])(
    "%s has a hint",
    (tag) => expect(ids(`Foo-${tag}`)).toEqual([tag]),
  );
  test("lowercase names of known formats have a hint", () => {
    expect(part("Foo-w4a16", "w4a16")?.entryId).toBe("format:W4A16");
    expect(part("Foo-int8", "int8")?.entryId).toBe("format:INT4");
  });
  test("the guide's own entry beats the general rule", () =>
    expect(part("Foo-W4A16", "W4A16")?.entryId).toBe("format:W4A16"));
  test("a two-part guide name stays one part", () => {
    expect(part("Foo-W8A8-INT8", "W8A8-INT8")?.entryId).toBe("format:W8A8-INT8");
    expect(part("Foo-W8A8-FP8", "W8A8-FP8")?.entryId).toBe("format:W8A8-FP8");
  });
  test("W and A alone are not quant names", () => {
    expect(ids("Foo-W6")).toEqual([]);
    expect(ids("Foo-A8")).toEqual([]);
    expect(ids("Foo-W6A")).toEqual([]);
  });
  test("a word that merely contains the pattern is not one", () =>
    expect(ids("Foo-XW6A8Y")).toEqual([]));
});

describe("underscore-joined names", () => {
  const texts = (s: string) => nameParts(s, KNOWLEDGE).map((p) => p.text);

  test.each([
    ["FLUX/flux3_image_klein_w6a8.safetensors", ["w6a8"]],
    ["realrebelai/Rebels_w6a8s", ["w6a8s"]],
    ["QWEN/qwen_image_2.1_w6a8.safetensors", ["w6a8"]],
    ["qwen_w6a8_lightning.safetensors", ["w6a8"]],
    ["model_Q4_K_M.gguf", ["Q4_K_M"]],
    ["flux_w8a8_int8.safetensors", ["w8a8", "int8"]],
  ])("%s", (name, want) => {
    expect(ids(name)).toEqual(want);
    expect(texts(name).join("")).toBe(name);
  });
  test("only quant names are found inside an underscore name", () =>
    expect(ids("some_model_it")).toEqual([]));
  test("a tag-like name with no quant in it stays one unknown part", () =>
    expect(nameParts("XQ_9", KNOWLEDGE)).toEqual([
      { text: "XQ_9", entryId: null, looksLikeTag: true },
    ]));
  test("the text around a found name is not called an unknown tag", () =>
    expect(
      nameParts("Rebels_w6a8s", KNOWLEDGE).find((p) => p.text === "Rebels_"),
    ).toMatchObject({ entryId: null, looksLikeTag: false }));
});

describe("LoRA names", () => {
  const LORA = "training:LoRA";
  const idOfPart = (name: string, text: string) =>
    nameParts(name, KNOWLEDGE).find((p) => p.text === text)?.entryId;

  test.each([
    ["style-LoRA-v2", "LoRA"],
    ["wan-lora-high", "lora"],
    ["Foo-LORA", "LORA"],
    ["Foo-loras", "loras"],
    ["pytorch_lora_weights.safetensors", "lora"],
    ["flux_lora.safetensors", "lora"],
  ])("%s has the LoRA hint", (name, text) => {
    expect(idOfPart(name, text)).toBe(LORA);
    expect(nameParts(name, KNOWLEDGE).map((p) => p.text).join("")).toBe(name);
  });
  test("a word that only contains lora is not one", () => {
    expect(ids("Foo-explorer-LoRaWAN-floral")).toEqual([]);
    expect(ids("floral_explorer")).toEqual([]);
  });
  test("every spelling gets one hint that says a base model is needed", () => {
    const e = KNOWLEDGE.entries.find((x) => x.id === LORA)!;
    expect(e.text).toMatch(/base model/);
    expect(KNOWLEDGE.entries.filter((x) => x.tokens.includes("LoRA") || x.patterns.some((p) => /lora/i.test(p)))).toHaveLength(1);
  });
});
