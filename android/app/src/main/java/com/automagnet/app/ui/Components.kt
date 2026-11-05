package com.automagnet.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.automagnet.app.Item

val Bg = Color(0xFF111827)
val Surface = Color(0xFF1F2937)
val Border = Color(0xFF374151)
val Muted = Color(0xFF9CA3AF)
val Accent = Color(0xFF6366F1)
val Green = Color(0xFF22C55E)
val Red = Color(0xFFEF4444)

@Composable
fun AmTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Accent, background = Bg, surface = Bg, surfaceVariant = Surface,
            onBackground = Color.White, onSurface = Color.White, outline = Border,
            surfaceContainer = Surface, surfaceContainerHigh = Surface,
        ),
        content = content,
    )
}

@Composable
fun SectionTitle(text: String) {
    Text(text, color = Muted, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.padding(16.dp, 16.dp, 16.dp, 8.dp))
}

/** Poster (2:3) or still (16:9) with a progress bar and watched mark. */
@Composable
fun Artwork(url: String?, fallback: String, wide: Boolean, progress: Float, watched: Boolean, badge: String? = null, modifier: Modifier = Modifier) {
    Box(
        modifier
            .aspectRatio(if (wide) 16f / 9f else 2f / 3f)
            .clip(RoundedCornerShape(8.dp))
            .background(Surface)
    ) {
        if (url != null) {
            AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            Text(
                fallback.split(" ").filter { it.isNotEmpty() }.take(2).joinToString("") { it.take(1).uppercase() },
                color = Muted, fontSize = 24.sp, modifier = Modifier.align(Alignment.Center),
            )
        }
        if (watched) {
            Box(Modifier.align(Alignment.TopEnd).padding(6.dp).size(22.dp).clip(CircleShape).background(Green), contentAlignment = Alignment.Center) {
                Text("✓", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        } else if (badge != null) {
            Box(Modifier.align(Alignment.TopEnd).padding(6.dp).clip(CircleShape).background(Accent).padding(horizontal = 7.dp, vertical = 2.dp)) {
                Text(badge, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
        if (progress > 0f && !watched) {
            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Color(0x88000000))) {
                Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).height(4.dp).background(Accent))
            }
        }
    }
}

fun progressOf(item: Item): Float {
    val p = item.progress ?: return 0f
    val d = p.duration ?: item.duration ?: return 0f
    return if (d > 0) (p.position / d).toFloat() else 0f
}

@Composable
fun ItemCard(item: Item, wide: Boolean, width: Dp, onClick: () -> Unit) {
    Column(Modifier.width(width).clickable(onClick = onClick), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Artwork(if (wide) item.stillUrl ?: item.posterUrl else item.posterUrl, item.heading, wide, progressOf(item), item.progress?.watched == true)
        Text(item.heading, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(item.subheading, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun ItemRow(title: String, items: List<Item>, wide: Boolean, onOpen: (Item) -> Unit) {
    if (items.isEmpty()) return
    SectionTitle(title)
    LazyRow(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(items, key = { it.key }) { ItemCard(it, wide, if (wide) 220.dp else 120.dp) { onOpen(it) } }
    }
}

@Composable
fun Centered(text: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, color = Muted)
        if (action != null) Row(Modifier.padding(top = 12.dp)) { action() }
    }
}

fun fmtSize(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1e9)
    bytes >= 1_000_000 -> "${bytes / 1_000_000} MB"
    else -> "${bytes / 1000} kB"
}
