import { describe, expect, test } from "bun:test"
import { emailDomain, isEduEmail, planAfterEmailVerification } from "../../src/billing/edu"

const allowlist = [".edu.in", ".ac.in"]

describe("edu detection", () => {
	test("accepts .edu.in and .ac.in", () => {
		expect(isEduEmail("student@iitb.ac.in", allowlist)).toBe(true)
		expect(isEduEmail("prof@nitk.edu.in", allowlist)).toBe(true)
		expect(isEduEmail("a@college.AC.IN", allowlist)).toBe(true)
	})

	test("rejects commercial and other domains", () => {
		expect(isEduEmail("you@gmail.com", allowlist)).toBe(false)
		expect(isEduEmail("x@edu.com", allowlist)).toBe(false)
		expect(isEduEmail("x@school.edu", allowlist)).toBe(false)
		expect(isEduEmail("not-an-email", allowlist)).toBe(false)
	})

	test("allowlist is configurable", () => {
		expect(isEduEmail("a@foo.ernet.in", [".ernet.in"])).toBe(true)
		expect(isEduEmail("a@iitb.ac.in", [".ernet.in"])).toBe(false)
	})

	test("planAfterEmailVerification picks edu vs free", () => {
		expect(planAfterEmailVerification("s@iitm.ac.in", allowlist)).toBe("edu")
		expect(planAfterEmailVerification("s@example.com", allowlist)).toBe("free")
	})

	test("emailDomain extracts host", () => {
		expect(emailDomain("A@B.Ac.In")).toBe("b.ac.in")
		expect(emailDomain("bad")).toBeNull()
	})
})
