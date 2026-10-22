package com.example.backend;

import com.example.backend.config.GuestIdentityFilter;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import static org.junit.jupiter.api.Assertions.*;

class GuestIdentityFilterTests {
    private final GuestIdentityFilter filter = new GuestIdentityFilter(
        "test-secret-at-least-thirty-two-bytes-long", new String[]{"https://askpool.test"}, true);

    private record Visit(String user, String cookie, MockHttpServletResponse response) {}
    private Visit visit(String token, String claimedId, String method, String origin) throws Exception {
        var request = new MockHttpServletRequest(method, "/api/me");
        if (token != null) request.setCookies(new Cookie("askpool_guest", token));
        if (claimedId != null) request.addHeader("X-User-Id", claimedId);
        if (origin != null) request.addHeader("Origin", origin);
        var response = new MockHttpServletResponse();
        String[] user = {null};
        filter.doFilter(request, response, (req, res) -> user[0] = ((HttpServletRequest) req).getHeader("X-User-Id"));
        String cookie = response.getHeader("Set-Cookie");
        if (cookie != null) cookie = cookie.split(";", 2)[0].substring("askpool_guest=".length());
        return new Visit(user[0], cookie, response);
    }

    @Test void distinctGuestsKeepTheirOwnSignedIdentityAndIgnoreHeaders() throws Exception {
        var first = visit(null, "pretend-professor", "GET", null);
        var second = visit(null, first.user(), "GET", null);
        assertNotEquals(first.user(), second.user());
        assertTrue(first.user().startsWith("guest:"));
        var returning = visit(first.cookie(), second.user(), "GET", null);
        assertEquals(first.user(), returning.user());
        assertNull(returning.cookie());
        var header = first.response().getHeader("Set-Cookie");
        assertTrue(header.contains("Secure"));
        assertTrue(header.contains("HttpOnly"));
        assertTrue(header.contains("SameSite=Lax"));
    }

    @Test void changedIdentityOrSignatureCannotImpersonateAnotherGuest() throws Exception {
        var first = visit(null, null, "GET", null);
        var second = visit(null, null, "GET", null);
        var forged = second.cookie().substring(0, 36) + first.cookie().substring(36);
        assertNotEquals(second.user(), visit(forged, null, "GET", null).user());
        assertNotEquals(first.user(), visit(first.cookie() + "x", null, "GET", null).user());
        assertNotEquals(first.user(), visit("broken", null, "GET", null).user());
    }

    @Test void mutationsRequireTheConfiguredOrigin() throws Exception {
        assertEquals(403, visit(null, null, "POST", "https://evil.test").response().getStatus());
        assertEquals(403, visit(null, null, "POST", null).response().getStatus());
        assertNotNull(visit(null, null, "POST", "https://askpool.test").user());
    }

    @Test void missingSigningSecretFailsAtStartup() {
        assertThrows(IllegalArgumentException.class, () -> new GuestIdentityFilter("", new String[]{"https://askpool.test"}, true));
    }
}
