import Foundation

/// The server sends every time as an ISO-8601 string with a `Z` or an offset, with or without fractional seconds.
/// These overloads make a plain `JSONDecoder` / `JSONEncoder` read and write `Date` fields of the models in that form,
/// whatever date strategy the app's own decoder has.
enum ISO8601 {
    static func date(from string: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }

    static func string(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

extension KeyedDecodingContainer {
    func decode(_ type: Date.Type, forKey key: Key) throws -> Date {
        let string = try decode(String.self, forKey: key)
        guard let date = ISO8601.date(from: string) else {
            throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "Not an ISO-8601 date: \(string)")
        }
        return date
    }

    func decodeIfPresent(_ type: Date.Type, forKey key: Key) throws -> Date? {
        guard let string = try decodeIfPresent(String.self, forKey: key) else { return nil }
        guard let date = ISO8601.date(from: string) else {
            throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "Not an ISO-8601 date: \(string)")
        }
        return date
    }
}

extension KeyedEncodingContainer {
    mutating func encode(_ value: Date, forKey key: Key) throws {
        try encode(ISO8601.string(from: value), forKey: key)
    }

    mutating func encodeIfPresent(_ value: Date?, forKey key: Key) throws {
        guard let value else { return }
        try encode(value, forKey: key)
    }
}
