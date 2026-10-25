package android.text;

/**
 * A stand-in for the platform class in JVM unit tests: the Play Billing Library's `Purchase` calls `isEmpty`, which the
 * mocked android.jar does not implement. Test sources come before it on the class path.
 */
public final class TextUtils {
    private TextUtils() {}

    public static boolean isEmpty(CharSequence text) {
        return text == null || text.length() == 0;
    }
}
