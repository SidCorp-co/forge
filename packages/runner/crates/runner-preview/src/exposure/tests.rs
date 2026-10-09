use super::*;

#[test]
fn a_server_on_loopback_alone_is_not_exposed() {
    let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = held.local_addr().unwrap().port();
    assert_eq!(beyond_loopback(port), None);
}

#[cfg(unix)]
#[test]
fn a_server_on_every_address_is_named_with_the_address_it_listens_on() {
    let held = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
    let port = held.local_addr().unwrap().port();
    assert_eq!(beyond_loopback(port), Some(format!("0.0.0.0:{port}")));
}

#[test]
fn the_kernel_rows_read_as_addresses() {
    // 127.0.0.1:8080 and 0.0.0.0:8080 listening, one established row on the port that is skipped
    let v4 = "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000";
    let any = "   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000";
    let est = "   2: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000";
    assert_eq!(listening_on(v4, 8080, false).as_deref(), Some("127.0.0.1"));
    assert_eq!(listening_on(any, 8080, false).as_deref(), Some("0.0.0.0"));
    assert_eq!(listening_on(est, 8080, false), None);
    assert_eq!(listening_on(v4, 8081, false), None);
    // ::1 and :: as /proc/net/tcp6 writes them
    let one = "   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 0 0 0";
    let all = "   1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 0 0 0";
    assert_eq!(listening_on(one, 8080, true).as_deref(), Some("::1"));
    assert_eq!(listening_on(all, 8080, true).as_deref(), Some("::"));
    assert!(is_loopback("::1") && !is_loopback("::") && !is_loopback("0.0.0.0"));
}

#[test]
fn an_ipv6_listener_is_named_in_brackets() {
    let Ok(held) = std::net::TcpListener::bind(("::", 0)) else {
        return; // a box with no IPv6 has no such listener to name
    };
    let port = held.local_addr().unwrap().port();
    assert_eq!(beyond_loopback(port), Some(format!("[::]:{port}")));
}
