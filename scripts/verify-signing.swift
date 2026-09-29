import Foundation
import Security
import CryptoKit

// Only public certificate records are read. No private key material is exported.
let fingerprint = CommandLine.arguments.dropFirst().first?.uppercased() ?? "-"
if fingerprint == "-" { exit(0) }
guard fingerprint.count == 40, fingerprint.utf8.allSatisfy({
  (48...57).contains($0) || (65...70).contains($0)
}) else {
  fputs("Use the exact 40-character certificate fingerprint for PALM_MAC_SIGNING_IDENTITY.\n", stderr)
  exit(2)
}
let query: [String: Any] = [kSecClass as String: kSecClassCertificate,
  kSecReturnRef as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
var items: CFTypeRef?
guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess,
  let certificates = items as? [SecCertificate],
  let certificate = certificates.first(where: {
    Insecure.SHA1.hash(data: SecCertificateCopyData($0) as Data)
      .map { String(format: "%02X", $0) }.joined() == fingerprint
  }) else {
  fputs("The requested public signing certificate was not found.\n", stderr)
  exit(2)
}
let codeSigning = SecPolicyCreateWithProperties(kSecPolicyAppleCodeSigning, nil)!
let revocation = SecPolicyCreateRevocation(
  CFOptionFlags(kSecRevocationUseAnyAvailableMethod | kSecRevocationRequirePositiveResponse))!
var reference: SecTrust?
guard SecTrustCreateWithCertificates(certificate, [codeSigning, revocation] as CFArray, &reference)
  == errSecSuccess, let trust = reference else {
  fputs("Apple signing trust could not be checked.\n", stderr)
  exit(2)
}
SecTrustSetNetworkFetchAllowed(trust, true)
var failure: CFError?
guard SecTrustEvaluateWithError(trust, &failure) else {
  let code = failure.map { CFErrorGetCode($0) } ?? 0
  fputs("Signing preflight rejected certificate \(fingerprint) (Apple trust error \(code)). No build was changed.\n", stderr)
  exit(1)
}
print("Apple code-signing trust verified for \(fingerprint), including a positive revocation response.")
