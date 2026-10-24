package dev.indiasubscriptions.models

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** A body the SDK could not read. Surfaces to callers as `PurchaseBackendException.MalformedResponse`. */
internal class DecodingException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** A string field, or null when it is absent or JSON null. A value of another type is a decoding error. */
internal fun JSONObject.optionalString(name: String): String? {
    if (!has(name) || isNull(name)) return null
    val value = get(name)
    return value as? String ?: throw DecodingException("'$name' is not a string")
}

internal fun JSONObject.requiredString(name: String): String =
    optionalString(name) ?: throw DecodingException("'$name' is missing")

internal fun JSONObject.optionalBoolean(name: String): Boolean? {
    if (!has(name) || isNull(name)) return null
    return get(name) as? Boolean ?: throw DecodingException("'$name' is not a boolean")
}

internal fun JSONObject.requiredBoolean(name: String): Boolean =
    optionalBoolean(name) ?: throw DecodingException("'$name' is missing")

internal fun JSONObject.optionalObject(name: String): JSONObject? {
    if (!has(name) || isNull(name)) return null
    return get(name) as? JSONObject ?: throw DecodingException("'$name' is not an object")
}

internal fun JSONObject.optionalArray(name: String): JSONArray? {
    if (!has(name) || isNull(name)) return null
    return get(name) as? JSONArray ?: throw DecodingException("'$name' is not an array")
}

/** An ISO-8601 time as milliseconds since the epoch, or null when absent. */
internal fun JSONObject.optionalTime(name: String): Long? =
    optionalString(name)?.let { Iso8601.parse(it) ?: throw DecodingException("'$name' is not an ISO-8601 time: $it") }

internal fun JSONObject.requiredTime(name: String): Long =
    optionalTime(name) ?: throw DecodingException("'$name' is missing")

internal inline fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T): List<T> {
    val result = ArrayList<T>(length())
    for (index in 0 until length()) {
        val element = get(index) as? JSONObject ?: throw DecodingException("element $index is not an object")
        result.add(transform(element))
    }
    return result
}

/** Runs the decoder, turning every parser failure into a [DecodingException]. */
internal inline fun <T> decoding(json: String, decode: (JSONObject) -> T): T {
    val root = try {
        JSONObject(json)
    } catch (error: JSONException) {
        throw DecodingException("Not a JSON object: ${error.message}", error)
    }
    try {
        return decode(root)
    } catch (error: JSONException) {
        throw DecodingException(error.message ?: "Unreadable JSON", error)
    }
}

/**
 * The service sends every time as an ISO-8601 string with a `Z` or an offset, with or without fractional seconds. This
 * reads them without `java.time`, which Android only has from API 26 and the library supports API 23.
 */
internal object Iso8601 {
    private val pattern =
        Regex("""^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:?\d{2})$""")

    fun parse(text: String): Long? {
        val match = pattern.matchEntire(text) ?: return null
        val g = match.groupValues
        val year = g[1].toInt()
        val month = g[2].toInt()
        val day = g[3].toInt()
        val hour = g[4].toInt()
        val minute = g[5].toInt()
        val second = g[6].toInt()
        if (month !in 1..12 || day !in 1..31 || hour > 23 || minute > 59 || second > 60) return null
        val millis = if (g[7].isEmpty()) 0L else g[7].padEnd(3, '0').substring(0, 3).toLong()
        val offsetSeconds = when (val zone = g[8]) {
            "Z", "z" -> 0
            else -> {
                val sign = if (zone[0] == '-') -1 else 1
                val digits = zone.substring(1).replace(":", "")
                sign * (digits.substring(0, 2).toInt() * 3600 + digits.substring(2).toInt() * 60)
            }
        }
        val days = daysFromCivil(year, month, day)
        return ((days * 86_400L + hour * 3600L + minute * 60L + second - offsetSeconds) * 1000L) + millis
    }

    /** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm). */
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = if (month <= 2) year - 1 else year
        val era = (if (y >= 0) y else y - 399) / 400
        val yoe = y - era * 400
        val doy = (153 * (month + (if (month > 2) -3 else 9)) + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097L + doe - 719_468L
    }
}
