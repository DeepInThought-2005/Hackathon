package com.example.backend.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** Browser-local guest ownership, deliberately not a verified school identity. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
@ConditionalOnProperty(name = "app.identity-mode", havingValue = "guest")
public class GuestIdentityFilter extends OncePerRequestFilter {
    private static final String COOKIE = "askpool_guest";
    private static final long LIFETIME = 180L * 24 * 60 * 60;
    private final byte[] secret;
    private final Set<String> origins;
    private final boolean secure;

    public GuestIdentityFilter(@Value("${app.guest-secret:}") String secret,
                               @Value("${app.frontend-origin}") String[] origins,
                               @Value("${app.guest-cookie-secure:true}") boolean secure) {
        if (secret.getBytes(StandardCharsets.UTF_8).length < 32)
            throw new IllegalArgumentException("Guest identity requires a persistent secret of at least 32 bytes");
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.origins = Set.of(origins);
        this.secure = secure;
    }

    private String sign(String payload) {
        try {
            var mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException error) {
            throw new IllegalStateException(error);
        }
    }

    private String identity(String token) {
        if (token == null || token.length() > 160) return null;
        var parts = token.split("\\.", -1);
        if (parts.length != 3 || !parts[0].matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) return null;
        try {
            long expires = Long.parseLong(parts[1]);
            long now = Instant.now().getEpochSecond();
            if (expires <= now || expires > now + LIFETIME + 60) return null;
            var expected = sign(parts[0] + "." + parts[1]);
            if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), parts[2].getBytes(StandardCharsets.UTF_8))) return null;
            return "guest:" + parts[0];
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!request.getRequestURI().startsWith("/api/")) {
            chain.doFilter(request, response);
            return;
        }
        response.setHeader("Cache-Control", "no-store");
        if (Set.of("POST", "PUT", "PATCH", "DELETE").contains(request.getMethod())
                && !origins.contains(request.getHeader("Origin") == null ? "" : request.getHeader("Origin"))) {
            response.sendError(403, "A same-origin request is required.");
            return;
        }
        String token = null;
        if (request.getCookies() != null)
            for (var cookie : request.getCookies())
                if (COOKIE.equals(cookie.getName())) token = cookie.getValue();
        String user = identity(token);
        if (user == null) {
            var payload = UUID.randomUUID() + "." + (Instant.now().getEpochSecond() + LIFETIME);
            token = payload + "." + sign(payload);
            user = identity(token);
            response.addHeader("Set-Cookie", ResponseCookie.from(COOKIE, token).httpOnly(true).secure(secure)
                    .sameSite("Lax").path("/").maxAge(LIFETIME).build().toString());
        }
        final String guestId = user;
        final String guestName = "Guest " + guestId.substring(6, 14);
        chain.doFilter(new HttpServletRequestWrapper(request) {
            @Override public String getHeader(String name) {
                if ("X-User-Id".equalsIgnoreCase(name)) return guestId;
                if ("X-User-Name".equalsIgnoreCase(name)) return guestName;
                return super.getHeader(name);
            }
            @Override public Enumeration<String> getHeaders(String name) {
                if ("X-User-Id".equalsIgnoreCase(name) || "X-User-Name".equalsIgnoreCase(name))
                    return Collections.enumeration(List.of(getHeader(name)));
                return super.getHeaders(name);
            }
            @Override public Enumeration<String> getHeaderNames() {
                var names = Collections.list(super.getHeaderNames());
                names.removeIf(name -> "X-User-Id".equalsIgnoreCase(name) || "X-User-Name".equalsIgnoreCase(name));
                names.add("X-User-Id");
                names.add("X-User-Name");
                return Collections.enumeration(names);
            }
        }, response);
    }
}
