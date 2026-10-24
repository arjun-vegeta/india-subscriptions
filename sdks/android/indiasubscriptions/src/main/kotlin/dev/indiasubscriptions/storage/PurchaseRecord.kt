package dev.indiasubscriptions.storage

import android.annotation.SuppressLint
import android.content.Context
import dev.indiasubscriptions.models.decoding
import dev.indiasubscriptions.models.mapObjects
import dev.indiasubscriptions.models.optionalArray
import dev.indiasubscriptions.models.optionalBoolean
import dev.indiasubscriptions.models.optionalString
import dev.indiasubscriptions.models.requiredString
import java.io.IOException
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the SDK remembers about one purchase between launches: the map from the obfuscated account id passed to Google
 * Play to the purchase session. A purchase that completes after the process died, or a pending one approved days later,
 * carries the account id, and this record says which session it completes. A record of a hosted checkout (a gateway, or
 * the alternative of user choice billing) is found by its session id when the app is opened through its return link.
 *
 * A record holds no purchase token of a confirmed purchase except the token's value to recognise it again, and no
 * customer details. The external transaction token of user choice billing is held only until the backend has it.
 */
public data class PurchaseRecord(
    /** The purchase session this record belongs to. It is the record's key. */
    val sessionId: String,
    /** The product key. */
    val product: String,
    val kind: Kind,
    /** The obfuscated account id passed to `BillingFlowParams.setObfuscatedAccountId`; null for a hosted checkout. */
    val accountId: String? = null,
    /** The Play Console product id of the Google Play option. */
    val googleProductId: String? = null,
    /** True when the billing client of the flow had user choice billing enabled. */
    val userChoice: Boolean = false,
    /** The return link the session was started with. A link opens this checkout's result only if it points there. */
    val returnUrl: String? = null,
    val state: State = State.OPEN,
    /** The external transaction token of user choice billing, until the backend has accepted it. */
    val externalTransactionToken: String? = null,
    /** The purchase tokens the backend confirmed. A later sighting of the same purchase is not sent again. */
    val completedPurchaseTokens: List<String> = emptyList(),
    /** Rounds of retrying that ended in a server failure that may be lasting. */
    val failedRounds: Int = 0,
    /** The server error code of the last refusal, for a [State.REJECTED] record. */
    val lastErrorCode: String? = null,
    val createdAtMillis: Long,
    /** When the session expires. An unfinished record is dropped a week after this. */
    val expiresAtMillis: Long,
    val updatedAtMillis: Long = createdAtMillis,
) {
    public enum class Kind {
        /** A purchase through Google Play Billing. */
        GOOGLE_PLAY,

        /** A purchase through a hosted checkout page: a gateway-only session, or the alternative of user choice billing. */
        HOSTED,
    }

    /** Where the purchase is, from the device's side. */
    public enum class State {
        /** The billing flow was launched; Google Play has not returned a purchase yet (or the app died before it did). */
        OPEN,

        /** Google Play said the purchase is pending (a cash payment, a family approval): it completes later. */
        PENDING,

        /** The customer chose the alternative; the backend does not have the external transaction token yet. */
        TOKEN_UNSENT,

        /** The hosted checkout page was opened; the outcome is read from the backend when the app is opened again. */
        AWAITING_RETURN,

        /** The backend confirmed the purchase. */
        COMPLETED,

        /**
         * The backend refused the purchase for a reason that will not change, or the SDK gave up. Never sent again
         * until `PurchaseClient.retryRejectedPurchases()`.
         */
        REJECTED,
    }

    internal fun toJson(): JSONObject = JSONObject().apply {
        put("sessionId", sessionId)
        put("product", product)
        put("kind", kind.name)
        accountId?.let { put("accountId", it) }
        googleProductId?.let { put("googleProductId", it) }
        put("userChoice", userChoice)
        returnUrl?.let { put("returnUrl", it) }
        put("state", state.name)
        externalTransactionToken?.let { put("externalTransactionToken", it) }
        put("completedPurchaseTokens", JSONArray(completedPurchaseTokens))
        put("failedRounds", failedRounds)
        lastErrorCode?.let { put("lastErrorCode", it) }
        put("createdAtMillis", createdAtMillis)
        put("expiresAtMillis", expiresAtMillis)
        put("updatedAtMillis", updatedAtMillis)
    }

    internal companion object {
        fun fromJson(json: JSONObject): PurchaseRecord = PurchaseRecord(
            sessionId = json.requiredString("sessionId"),
            product = json.requiredString("product"),
            kind = enumOrNull<Kind>(json.optionalString("kind")) ?: Kind.GOOGLE_PLAY,
            accountId = json.optionalString("accountId"),
            googleProductId = json.optionalString("googleProductId"),
            userChoice = json.optionalBoolean("userChoice") ?: false,
            returnUrl = json.optionalString("returnUrl"),
            // A state written by a version this SDK does not know is treated as not settled, so it is looked at again.
            state = enumOrNull<State>(json.optionalString("state")) ?: State.OPEN,
            externalTransactionToken = json.optionalString("externalTransactionToken"),
            completedPurchaseTokens = json.optionalArray("completedPurchaseTokens")?.let { array ->
                List(array.length()) { array.getString(it) }
            } ?: emptyList(),
            failedRounds = json.optInt("failedRounds", 0),
            lastErrorCode = json.optionalString("lastErrorCode"),
            createdAtMillis = json.getLong("createdAtMillis"),
            expiresAtMillis = json.getLong("expiresAtMillis"),
            updatedAtMillis = json.getLong("updatedAtMillis"),
        )

        private inline fun <reified E : Enum<E>> enumOrNull(name: String?): E? =
            name?.let { enumValues<E>().firstOrNull { value -> value.name == it } }
    }
}

/** Encodes the records as one JSON document, and reads it back. */
internal object PurchaseRecordCodec {
    private const val VERSION = 1

    fun encode(records: List<PurchaseRecord>): String = JSONObject().apply {
        put("version", VERSION)
        put("records", JSONArray().also { array -> records.forEach { array.put(it.toJson()) } })
    }.toString()

    fun decode(text: String): List<PurchaseRecord> = decoding(text) { root ->
        root.optionalArray("records")?.mapObjects { PurchaseRecord.fromJson(it) } ?: emptyList()
    }
}

/**
 * Where the SDK keeps its [PurchaseRecord]s. Reads and writes are small and synchronous: the SDK calls them from its
 * I/O dispatcher, one at a time, and replaces the whole list on every change. A `save` that returns has made the
 * records durable (the SDK writes a record before it launches Google's purchase screen).
 */
public interface PurchaseRecordStore {
    /** Reads every record. Throws when the storage cannot be read. */
    public fun load(): List<PurchaseRecord>

    /** Replaces every record. Throws when the storage cannot be written. */
    public fun save(records: List<PurchaseRecord>)
}

/**
 * Keeps the records in a private `SharedPreferences` file as one JSON value, written with `commit()` so that a record
 * is on disk before the billing flow starts. The file holds session ids, which are capabilities: exclude it from
 * Auto Backup and device transfer (see the README).
 */
public class SharedPreferencesPurchaseRecordStore(
    context: Context,
    name: String = DEFAULT_NAME,
) : PurchaseRecordStore {
    private val preferences = context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)

    override fun load(): List<PurchaseRecord> {
        val text = preferences.getString(KEY, null) ?: return emptyList()
        return PurchaseRecordCodec.decode(text)
    }

    @SuppressLint("ApplySharedPref") // `apply()` writes later: a process killed after the payment could lose the record.
    override fun save(records: List<PurchaseRecord>) {
        if (!preferences.edit().putString(KEY, PurchaseRecordCodec.encode(records)).commit()) {
            throw IOException("The purchase records could not be written")
        }
    }

    public companion object {
        /** The default name of the preferences file. */
        public const val DEFAULT_NAME: String = "dev.indiasubscriptions.purchase-records"
        private const val KEY = "records"
    }
}

/**
 * Keeps the records in memory. For tests and for apps that do not want a map to survive a launch (they then lose
 * recovery of a purchase interrupted by a kill).
 */
public class InMemoryPurchaseRecordStore(records: List<PurchaseRecord> = emptyList()) : PurchaseRecordStore {
    private var records: List<PurchaseRecord> = records

    @Synchronized
    override fun load(): List<PurchaseRecord> = records

    @Synchronized
    override fun save(records: List<PurchaseRecord>) {
        this.records = records.toList()
    }
}
