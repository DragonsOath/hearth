package com.dragonsoath.hearth

import android.util.Log
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * Passes every byte between this device's own address (127.0.0.1) and your Hearth on the home
 * network, unchanged, WebSockets included. Android only lets a page use the microphone on a
 * secure address, and this device's own address counts as one; your Hearth at
 * http://192.168.x.x does not. Through this, voice and the War Room's microphone work in the app
 * without certificates. Nothing is read or changed on the way.
 */
class Forwarder(private val targetHost: String, private val targetPort: Int) {
    private var server: ServerSocket? = null

    /** The local port, fixed per Hearth so its sign-in (a cookie) is kept between launches. */
    val localPort: Int = 47000 + Math.floorMod("$targetHost:$targetPort".hashCode(), 900)

    /** Starts listening (on the fixed port, or the next free one); returns the port in use. */
    fun start(): Int {
        var p = localPort
        while (server == null) {
            try {
                server = ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), p))
                }
            } catch (e: Exception) {
                p++
                if (p > localPort + 50) throw e
            }
        }
        val s = server!!
        thread(isDaemon = true, name = "hearth-forwarder") {
            while (!s.isClosed) {
                val client = try {
                    s.accept()
                } catch (_: Exception) {
                    break
                }
                thread(isDaemon = true) { connect(client) }
            }
        }
        return s.localPort
    }

    private fun connect(client: Socket) {
        val upstream = try {
            Socket().apply {
                tcpNoDelay = true
                // Not "port": inside here that would be this new socket's own (still 0).
                connect(InetSocketAddress(targetHost, targetPort), 10_000)
            }
        } catch (e: Exception) {
            Log.w("HearthForwarder", "Can't reach $targetHost:$targetPort", e)
            client.close()
            return
        }
        client.tcpNoDelay = true
        thread(isDaemon = true) { pipe(client.getInputStream(), upstream.getOutputStream(), client, upstream) }
        pipe(upstream.getInputStream(), client.getOutputStream(), client, upstream)
    }

    private fun pipe(from: InputStream, to: OutputStream, a: Socket, b: Socket) {
        val buf = ByteArray(32 * 1024)
        try {
            while (true) {
                val n = from.read(buf)
                if (n < 0) break
                to.write(buf, 0, n)
                to.flush()
            }
        } catch (_: Exception) {
            // One side closed: close both.
        } finally {
            try { a.close() } catch (_: Exception) {}
            try { b.close() } catch (_: Exception) {}
        }
    }

    fun stop() {
        try { server?.close() } catch (_: Exception) {}
        server = null
    }
}
