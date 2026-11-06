// The enclave root key: a P-256 key made inside this Mac's Secure Enclave. It never leaves the chip.
// The file it writes is a wrapped handle only this Mac's chip can use, and every signature asks for Touch ID or the login password.
//
//   enclave create <handle-file>   makes the key, writes the handle, prints the public key (65 bytes, hex)
//   enclave public <handle-file>   prints the public key again
//   enclave sign <handle-file>     signs stdin, prints r||s (64 bytes, hex): ECDSA P-256 over SHA-256 of the message
import CryptoKit
import Foundation
import LocalAuthentication

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("enclave: \(message)\n".utf8))
    exit(1)
}

func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

let args = CommandLine.arguments
guard args.count == 3, ["create", "public", "sign"].contains(args[1]) else {
    fail("usage: enclave create|public|sign <handle-file>")
}
guard SecureEnclave.isAvailable else { fail("this Mac has no Secure Enclave") }
let path = URL(fileURLWithPath: args[2])

func load() -> SecureEnclave.P256.Signing.PrivateKey {
    guard let handle = try? Data(contentsOf: path) else { fail("can't read \(path.path)") }
    let context = LAContext()
    context.localizedReason = "sign the CELLO issuer list"
    do { return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: handle, authenticationContext: context) } catch {
        fail("this handle doesn't open on this Mac's chip: \(error)")
    }
}

switch args[1] {
case "create":
    if FileManager.default.fileExists(atPath: path.path) { fail("\(path.path) already exists. Nothing was changed.") }
    var cfError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &cfError) else {
        fail("can't set Touch ID on the key: \(String(describing: cfError?.takeRetainedValue()))")
    }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        try key.dataRepresentation.write(to: path, options: [.withoutOverwriting])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        print(hex(key.publicKey.x963Representation))
    } catch { fail("couldn't make the key: \(error)") }
case "public":
    print(hex(load().publicKey.x963Representation))
default:
    let message = FileHandle.standardInput.readDataToEndOfFile()
    do { print(hex(try load().signature(for: message).rawRepresentation)) } catch { fail("signing failed: \(error)") }
}
