import { describe, expect, it } from "vitest";
import { createAppJwt, importRsaPrivateKey } from "./app";

// Throwaway fixture keys generated for this test — no security value.
const PKCS1_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAqH/vaQ8JgHgyBUIjb6lQ2iCIAkb48d+ytSS5kMxd7tyjaga1
61TWDB8tZtzsg3i9nfw6i75KRcO7PsZfc2+YLT5s7laQRjodxhVZ1aBgq0p3uG9M
f40T6OCdkpJwRB+jTznJd5Jhl8MDsgyf84P+z57fT6qfhr6lzzODgh9lKOll/60u
CONtJNgNB2AfU3JuY8QAAQeYAXC0tG9/7N4TYXoaS01j3959TNEQZ6ab/+5/bIKd
yFMqrNQo3Lup+ac3q6uNmT7N7Mi6TYqSUij4030WtI8RDsBvHp/rNxFj1iz9jAwt
pJgElqIHQYE+9hYMgv6YwvzXU2gYg5C1LsCl4QIDAQABAoIBAAGwwuShb3139zyB
RNy+bJ67m9G2B5JZpa/WjfwLaNfYI9WQ+qtBPyKA/5IcHk1VXUWj/axgPNuFUrAX
CmcclADEMxCTEsB5ncnadfvEL6QYS6owh6px7mS0ODB7wp+UV62YTVKjR9JfdP6I
zOQDC3/mvqPMeOw/pmc1Q5j/GqM17AvfYtHN44cvseiwLlZKusNEQmHFjqWhmbXn
Qy+5kYdU4JH9UrB8Xul3GFxCVs214wzcG2BfzpLYYG8hOautcWo2i8bidJqFkDkl
9R3YY2AnMxEAlQqGRo5wAbsUtIocREEldyxZhd/oi4ZswcG25OU9ShdlRCc+qF+C
ybGEo18CgYEA6IpvAicWeliDQGnsAf56mEmgnl62UtBPwu+omlbHaefWV+RRhVwP
ofSo0pgdvFbDpGm8jOZ1l1pG2ThNGv9V0ZK55oO2yhERgf14peEwh3PqeeVzVgHC
9yYQ6GXCqN7CBoWqRD6jceewVnwjUP4CRvqmOjEE+JahkBj49mhf8JsCgYEAuX+W
SQJs1+dN8tEz3IPb+eyTQ0CdB/1xaFNKdqAcyv+dLbiYUdaFsriE+bsEFGYf2iLV
jFCQss0F5udWsOOw8vuQH52279C/sLw9bZa8ZXth25xvOulvhIq8f/Xug1xV/hEy
3sNS52T/idjrY5ClJwOA7ZXqzsUGiSEjDeOlFTMCgYEAwStmJaqkwINQnKygsdNc
sa7P718MI+UJrQx6yaL2ymIdKyvuEFM2ZTohF7fnU7HbmXOAfqde3ZjPq9haLOgY
uRwis3uM13SwT4RouZtEPfErwZC6a6LQ+4+ykesedjt9f/9/PmuuSIvHb0B18ezf
pWjHtyVLVNmEYnhsL/zqXasCgYB2vKKYLUM6mEae7SaDOqwuOC6zV8KsgKB9JQN/
F1IW5rPXtldZ2zVNhysnJ3yfChfNa4rB/DgDG5VxjhdBtx1nC3vfoPaeX0K0gGnZ
oikJ1IZ5KpNQZGgLsTqjtepsj0hEDwI+8Uw57b5coEtcOhRc+rMmYVYh8KAUWu+z
Tko3XQKBgBPDAx0GLTjgVOHMXpl+FLDGArI/UXjuEuJUTzXiS75miviXcfCEE52I
XwMBNHj208IHxg0xzvEu4mfvjx/5oLoHf672sOsXg+Dj3u4P2D0bsng5/viTSIeF
vO3DPb51rjoDpQt7dyL151bjmiFzGBMFjhPbZ4e8F+TxdAGuhtNI
-----END RSA PRIVATE KEY-----
`;
const PKCS8_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDwAOp/SI0nvI3J
eObcwQCXmptcnkMK1JzlyjPzCwRD0LF62x3Um7qBhai3LAtHFSix/G8ALcUoxVu8
XmNdMFgqtXfG4NB10dWZ5k9JFWPFkfjVpujDxp+z2KQgq1a4gguvnxIoleG4uL5y
Bq2JvL3yGhqyScYQpd9LPddsyHcUo6ISWolw3Aja3TJxMHmMUTUTsFWhvahdbTdl
W8wbmuennyAer1pci3mbnEaLxpMQGwEaatvn2YtzQa3CH4hS8E0vBDzCNvdupsUw
ga/Vz5H9aurMiMTNyJPZoeNSJGtElXy/OB452DXMK9HHkDFFvTPP89YS1O+hdsEa
5DQNuEE7AgMBAAECggEAAWKH998OeCBlkw2LC31jnacAkYAU8/Q2dDmpThQ4sel7
igbHUnQ+7G4TLfy86JaYgFpsC4y4EAb/g1k/aoi+YX9gPGS3XzlW6bHuBYZwPRzI
BPeXF+txUs4uYu/fgBC5X4nj8W8Co+27pO3L745dbDm2q2OzQberT68A1g8GvOGS
pVGgFXKrr3DNdjo4mV0Opt3/UdwD52Nubx958B620VHmWOORPmUZC0I/80apEfYG
mhaDuF1hac0hT86g7LgSiMA4ZJ4IGnQj8eqrVugWH5/O+Z0voa+HXCPGW+WgtOvV
a5Y/XugSKJYgfUj0PvOTgJ9xM7CiAGBkaIZTRzdVzQKBgQD6RqvFApYc+mwHFW8l
vqa+TRgZdXirYoLz6RwPYIaYrOkqzqKOay9fD4J8siNdMy4Ca9fGE2q7J2e/KsrE
Bz4ytGVxELBPhgD0IJImIi+VptqkE3npa/hwNOWztyL0RNpVCdYKYOiyXlDeFns+
5bGBSEOm7N4tDJVVwwfayGjd3QKBgQD1fhnneEFRdO2Rjr24uXoqGxzKbe65dpHt
0HojrMKqWDVWX1bVOFI3airL3Q9mok37VUBJ7IJeq9YE+RP2CrXhgliFZoxfmQ3M
Dy5vBgmRzTBOyTIeJgUi2jxbJwfTXpbuySBxKYg8BGVzIX5q0sven2tA/31X9KDN
q4gWyepl9wKBgQDTKdN9uuvq8UM6StRnlU9cmvFtcZbpi4mPwCwDsV5+7M0iaAvx
e/ARFaX0Dd0Worr8If+BSRqxY9L+EV3ZPX82CszYM8t+nUKqt9x3vjpF2uz4qNIg
pw+LpKX2FtuwG3PXciAcy50p+bfjWjaMYAJ/YPhrm8jtW4OYQ6CZ8KPCJQKBgQDW
XFguQFl40UsokKWliX/dCHOpZzjPBXQDXsloIVCSAhgA5Zsi790Kuk/IV609B3hk
gFp0smpcVFu7V+tQKqYK1hCJ27OzPihICPGYzILKp4sJILH8lWJivoF5bqlsrenJ
dCI57fQhxAz57UM/7/VI3Zd/2BgRF3DaZm+cxo9AnQKBgQCrXx+oCBZ0LyE8+xJ1
UXheVKpf4ypPgpt4Xp6fqYKqjtrjS+qy9CzildcdnXFeP9qc9W/maoUG8AD2Eg6h
Fr9acRbEg7+8BvYqpqUlkmXhgdMY81dAOEigY4erf2K5+SbK+9xHxn/sjAdPpnhx
IGJLh1XA98s5GdKILzkKWFuxGQ==
-----END PRIVATE KEY-----
`;

describe("createAppJwt", () => {
  const cases: Array<[string, string]> = [
    ["pkcs8 pem", PKCS8_PEM],
    ["pkcs1 pem (GitHub App format)", PKCS1_PEM],
    ["pkcs1 with \\n escapes", PKCS1_PEM.replace(/\n/g, "\\n")],
  ];

  it.for(cases)("imports and signs a JWT from %s", async ([, pem]) => {
    const jwt = await createAppJwt("5731368", pem);
    const [header = "", payload = "", sig = ""] = jwt.split(".");
    expect(JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).iss).toBe("5731368");
    expect(sig.length).toBeGreaterThan(200);
  });

  it("rejects garbage PEMs", async () => {
    await expect(importRsaPrivateKey("not a pem")).rejects.toThrow(/PEM marker/);
  });
});
