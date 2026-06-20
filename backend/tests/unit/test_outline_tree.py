"""Unit tests for outline tree reconstruction — pure logic, no PDF needed."""

from __future__ import annotations

from app.pdf.pdfium_backend import _build_outline_tree


def test_empty_flat_yields_empty_tree():
    assert _build_outline_tree([]) == ()


def test_single_root():
    tree = _build_outline_tree([(0, "Only", 1)])
    assert len(tree) == 1
    assert tree[0].title == "Only"
    assert tree[0].page_index == 1
    assert tree[0].children == ()


def test_two_roots():
    tree = _build_outline_tree([(0, "A", 0), (0, "B", 5)])
    assert [n.title for n in tree] == ["A", "B"]
    assert all(n.children == () for n in tree)


def test_nested_two_levels():
    flat = [
        (0, "Chapter 1", 0),
        (1, "  1.1", 1),
        (1, "  1.2", 2),
        (0, "Chapter 2", 3),
        (1, "  2.1", 4),
    ]
    tree = _build_outline_tree(flat)
    assert [n.title for n in tree] == ["Chapter 1", "Chapter 2"]
    assert [c.title for c in tree[0].children] == ["  1.1", "  1.2"]
    assert [c.title for c in tree[1].children] == ["  2.1"]


def test_deep_nesting():
    flat = [
        (0, "A", 0),
        (1, "A1", 1),
        (2, "A1a", 2),
        (3, "A1a-i", 3),
        (0, "B", 4),
    ]
    tree = _build_outline_tree(flat)
    assert len(tree) == 2
    assert tree[0].children[0].children[0].children[0].title == "A1a-i"


def test_level_jump_treats_as_sibling_under_nearest_ancestor():
    # Malformed but possible: level skips from 0 to 2 directly.
    # We treat it gracefully — the depth-2 node attaches to the depth-0 root.
    flat = [(0, "A", 0), (2, "Orphan", 1), (0, "B", 2)]
    tree = _build_outline_tree(flat)
    assert [n.title for n in tree] == ["A", "B"]
    assert tree[0].children[0].title == "Orphan"
