import { describe, expect, it } from "vitest";
import { publicSuffix, registrableDomain } from "../src/lib/public-suffix";
import { effectiveDomain } from "../src/lib/security-heuristics";

/** Cases lifted from the list's own test file at https://publicsuffix.org/list/tests.txt. */
describe("the published algorithm", () => {
  it("handles ordinary names", () => {
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("www.example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("com")).toBe("");
  });

  it("handles multi-label suffixes", () => {
    expect(publicSuffix("foo.co.uk")).toBe("co.uk");
    expect(registrableDomain("foo.co.uk")).toBe("foo.co.uk");
    expect(registrableDomain("a.b.foo.co.uk")).toBe("foo.co.uk");
    expect(registrableDomain("co.uk")).toBe("");
    expect(registrableDomain("foo.com.au")).toBe("foo.com.au");
    expect(registrableDomain("www.foo.com.au")).toBe("foo.com.au");
  });

  it("handles wildcard rules", () => {
    expect(registrableDomain("ck")).toBe("");
    expect(registrableDomain("test.ck")).toBe("");
    expect(registrableDomain("b.test.ck")).toBe("b.test.ck");
    expect(registrableDomain("a.b.test.ck")).toBe("b.test.ck");
  });

  it("handles exception rules, which beat the wildcard that covers them", () => {
    expect(publicSuffix("www.ck")).toBe("ck");
    expect(registrableDomain("www.ck")).toBe("www.ck");
    expect(registrableDomain("www.www.ck")).toBe("www.ck");
  });

  it("matches rules written in Unicode against hostnames written in punycode", () => {
    expect(publicSuffix("xn--e1afmkfd.xn--p1ai")).toBe("xn--p1ai");
    expect(registrableDomain("xn--e1afmkfd.xn--p1ai")).toBe("xn--e1afmkfd.xn--p1ai");
    expect(registrableDomain("a.b.xn--3e0b707e")).toBe("b.xn--3e0b707e");
  });

  it("treats a name under an unknown suffix as if the rule were '*'", () => {
    expect(registrableDomain("foo.bar.invalidtldthatwillneverexist")).toBe("bar.invalidtldthatwillneverexist");
  });
});

/**
 * Each of these was wrong under the 55-entry hand-written list this replaced, in the direction that
 * matters: two different people's sites read as one, or one site read as two.
 */
describe("cases the short built-in list got wrong", () => {
  it("separates sites that share a hosting suffix", () => {
    expect(effectiveDomain("user-a.github.io")).toBe("user-a.github.io");
    expect(effectiveDomain("user-b.github.io")).toBe("user-b.github.io");
    expect(effectiveDomain("bucket.s3.amazonaws.com")).toBe("bucket.s3.amazonaws.com");
    // *.compute.amazonaws.com: the wildcard label is part of the suffix, so the registrable name
    // is one label further left than it looks.
    expect(effectiveDomain("a.b.compute.amazonaws.com")).toBe("a.b.compute.amazonaws.com");
    expect(effectiveDomain("b.compute.amazonaws.com")).toBe("b.compute.amazonaws.com");
  });

  it("gets country suffixes it had never heard of right", () => {
    expect(effectiveDomain("dept.gov.br")).toBe("dept.gov.br");
    expect(effectiveDomain("school.pvt.k12.ma.us")).toBe("school.pvt.k12.ma.us");
    expect(effectiveDomain("shop.co.zw")).toBe("shop.co.zw");
    expect(effectiveDomain("news.gov.scot")).toBe("news.gov.scot");
  });

  it("still folds subdomains of one site together", () => {
    expect(effectiveDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(effectiveDomain("accounts.example.com")).toBe("example.com");
  });

  it("compares a bare public suffix as itself rather than widening it", () => {
    expect(effectiveDomain("co.uk")).toBe("co.uk");
  });
});
